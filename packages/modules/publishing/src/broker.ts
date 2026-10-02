import { NotFoundError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import { requireTenant, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { aadFor, envelopeFromRow, envelopeToRow, open, seal, type EnvelopeRow } from './envelope';
import { LocalKms, WrapOnlyKms, type Kms } from './kms';
import { ChannelConnectionRepository, CredentialRefRepository } from './repositories';

/**
 * Spec 14.7 credential broker (critical tier). Tokens are sealed with a per-record data key wrapped by KMS and
 * bound to `${tenantId}:${channelConnectionId}`; they are opened only in memory, only in a process whose KMS may
 * decrypt (worker-core, worker-ingest), and never appear in the DB, logs, events or Temporal payloads. The API
 * process is composed with WrapOnlyKms, so withCredentials there throws credential_decrypt_not_permitted before
 * a single row is read.
 */
export interface CredentialBrokerConfig {
  kms: Kms;
}

let config: CredentialBrokerConfig | null = null;
export const configureCredentialBroker = (cfg: CredentialBrokerConfig | null): void => {
  config = cfg;
};

const connectionsRepo = new ChannelConnectionRepository();
const credentialsRepo = new CredentialRefRepository();

/**
 * A credential reference as another module holds it (ledger R2-1: a brand destination's Google grant): the owning
 * tenant, the credential_refs row id and the AAD the owner sealed it under (`${tenantId}:${destinationId}`). The
 * owner module never reads credential_refs itself; it stores the id the broker returns and asks the broker to
 * open, rotate or destroy the row.
 */
export interface CredentialRefTarget {
  tenantId: string;
  credentialRefId: string;
  aad: string;
}

/**
 * RA-01: why a credential is opened. A disconnected channel's credential is unusable from the moment of the
 * disconnect: only the remote revoke (channelRevokeWorkflowV1, which destroys it right after) may open it, by
 * saying so; every other caller is refused with `credential_owner_disconnected`.
 */
export interface CredentialOpenOptions {
  purpose?: 'revoke';
}

/** What the broker hands the caller next to the plaintext: references the adapter needs, never the row. */
export interface ConnectionRef {
  channelConnectionId: string;
  providerKey: string;
  remoteAccountId: string;
  credentialRefId: string;
}

function kms(): Kms {
  if (!config)
    throw new Error(
      'credential broker not configured (composition root must call configureCredentialBroker)',
    );
  return config.kms;
}

/** Best effort after use: strings are immutable in JS, so the object's references are dropped and overwritten. */
function scrub(creds: DecryptedCredentials): void {
  const c = creds as unknown as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (key === 'extra' && c['extra'] && typeof c['extra'] === 'object') {
      const extra = c['extra'] as Record<string, unknown>;
      for (const k of Object.keys(extra)) extra[k] = '';
    }
    c[key] = typeof c[key] === 'string' ? '' : undefined;
  }
}

export const credentialBroker = {
  /** True in worker-core / worker-ingest; false in the API process (spec 14.7 IAM policy, WrapOnlyKms here). */
  canDecrypt(): boolean {
    return !(kms() instanceof WrapOnlyKms);
  },

  /** Any process may seal (connect and refresh write new rows); the row values are what credential_refs stores. */
  async seal(
    tenantId: string,
    channelConnectionId: string,
    credentials: DecryptedCredentials,
  ): Promise<EnvelopeRow> {
    return envelopeToRow(await seal(kms(), credentials, aadFor(tenantId, channelConnectionId)));
  },

  /** Stores a sealed grant as a new credential_refs row in the tenant in context; the id is what the owner keeps. */
  async createCredentialRef(envelope: EnvelopeRow, tx: Tx): Promise<string> {
    const id = newId('credentialRef');
    await credentialsRepo.create({ id, ...envelope }, tx);
    return id;
  },

  /** Whether a credential row still holds its key material (RA-01: what the shred floors look for). */
  async credentialRefIntact(credentialRefId: string, tx?: Tx): Promise<boolean> {
    return (await credentialsRepo.getById(credentialRefId, tx)).destroyedAt === null;
  },

  /** Crypto-shreds a credential row (data key and ciphertext overwritten); one destroyed already is left as it is. */
  async destroyCredentialRef(
    credentialRefId: string,
    reason: 'rotated' | 'disconnected',
    tx: Tx,
  ): Promise<void> {
    const row = await credentialsRepo.getById(credentialRefId, tx);
    if (!row.destroyedAt) await credentialsRepo.destroy(row.id, row.version, reason, tx);
  },

  /**
   * The generic form of withCredentials for a credential another module owns: decrypts in memory under the AAD
   * the owner names, hands the plaintext to `fn`, scrubs it afterwards. The same process boundary applies (the
   * API's WrapOnlyKms refuses), the tenant in context must be the owner (a mismatch or a foreign id is NOT_FOUND,
   * spec 5.3) and a destroyed row is credential_destroyed.
   */
  async withCredentialRef<T>(
    target: CredentialRefTarget,
    fn: (credentials: DecryptedCredentials) => Promise<T>,
    tx?: Tx,
  ): Promise<T> {
    if (!this.canDecrypt())
      throw new PolicyDeniedError(
        'credential_decrypt_not_permitted',
        'This process is not permitted to decrypt credentials',
      );
    const ctx = requireTenant();
    if (ctx.tenantId !== target.tenantId) throw new NotFoundError('CredentialRef', target.credentialRefId);
    const credential = await credentialsRepo.getById(target.credentialRefId, tx);
    if (credential.destroyedAt)
      throw new PolicyDeniedError('credential_destroyed', 'The credential has been revoked');
    const credentials = await open(kms(), envelopeFromRow(credential), target.aad);
    try {
      return await fn(credentials);
    } finally {
      scrub(credentials);
    }
  },

  /**
   * Decrypts in memory, hands the plaintext to `fn`, scrubs it afterwards. The tenant in context must own the
   * connection: a mismatch or a foreign id is NOT_FOUND, never a decrypt (spec 5.3).
   */
  async withCredentials<T>(
    tenantId: string,
    channelConnectionId: string,
    fn: (credentials: DecryptedCredentials, connection: ConnectionRef) => Promise<T>,
    tx?: Tx,
    opts: CredentialOpenOptions = {},
  ): Promise<T> {
    if (!this.canDecrypt())
      throw new PolicyDeniedError(
        'credential_decrypt_not_permitted',
        'This process is not permitted to decrypt channel credentials',
      );
    const ctx = requireTenant();
    if (ctx.tenantId !== tenantId) throw new NotFoundError('ChannelConnection', channelConnectionId);
    const connection = await connectionsRepo.getById(channelConnectionId, tx);
    if (connection.status === 'disabled' && opts.purpose !== 'revoke')
      throw new PolicyDeniedError(
        'credential_owner_disconnected',
        'The channel is disconnected; its credential is no longer usable',
      );
    const credential = await credentialsRepo.getById(connection.credentialRefId, tx);
    if (credential.destroyedAt)
      throw new PolicyDeniedError('credential_destroyed', 'The channel credential has been revoked');
    const credentials = await open(kms(), envelopeFromRow(credential), aadFor(tenantId, channelConnectionId));
    try {
      return await fn(credentials, {
        channelConnectionId: connection.id,
        providerKey: connection.providerKey,
        remoteAccountId: connection.remoteAccountId,
        credentialRefId: credential.id,
      });
    } finally {
      scrub(credentials);
    }
  },
};

/**
 * Appendix A: KMS_KEY_ID_CREDENTIALS names the cloud key; until the cloud adapter lands, LocalKms wraps with a
 * master secret from KMS_LOCAL_MASTER_SECRET (development and tests). `decrypt: false` composes the API process.
 */
export function createKmsFromEnv(opts: { decrypt: boolean }, env: NodeJS.ProcessEnv = process.env): Kms {
  const secret = env['KMS_LOCAL_MASTER_SECRET'];
  if (!secret) throw new Error('KMS_LOCAL_MASTER_SECRET is required (cloud KMS adapter not configured)');
  const inner = new LocalKms(secret, env['KMS_KEY_ID_CREDENTIALS'] ?? 'local-kms');
  return opts.decrypt ? inner : new WrapOnlyKms(inner);
}
