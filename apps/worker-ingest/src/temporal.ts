import { readFile } from 'node:fs/promises';
import { Client, Connection, type ConnectionOptions } from '@temporalio/client';
import type { NativeConnectionOptions } from '@temporalio/worker';

export interface TemporalConfig {
  address: string;
  namespace: string;
  /** Temporal Cloud API key (TLS implied). */
  apiKey?: string;
  /** mTLS: paths of the PEM files the platform mounts from the secret references (Appendix A). */
  tlsCertPath?: string;
  tlsKeyPath?: string;
  /** Server-side TLS without client certificates (TEMPORAL_TLS=1). */
  tls?: boolean;
}

/** Appendix A names only; values come from the secret manager. Missing address is a startup error, never a default. */
export function temporalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TemporalConfig {
  const address = env['TEMPORAL_ADDRESS'];
  if (!address) throw new Error('TEMPORAL_ADDRESS is required');
  const cfg: TemporalConfig = { address, namespace: env['TEMPORAL_NAMESPACE'] ?? 'default' };
  if (env['TEMPORAL_API_KEY']) cfg.apiKey = env['TEMPORAL_API_KEY'];
  if (env['TEMPORAL_TLS_CERT_REF']) cfg.tlsCertPath = env['TEMPORAL_TLS_CERT_REF'];
  if (env['TEMPORAL_TLS_KEY_REF']) cfg.tlsKeyPath = env['TEMPORAL_TLS_KEY_REF'];
  if (env['TEMPORAL_TLS'] === '1') cfg.tls = true;
  return cfg;
}

/** Temporal Cloud: mTLS client certificate files or an API key; self-hosted: plain address (Appendix A). */
export async function connectionOptions(cfg: TemporalConfig): Promise<NativeConnectionOptions> {
  const options: NativeConnectionOptions = { address: cfg.address };
  if (cfg.tlsCertPath && cfg.tlsKeyPath)
    options.tls = {
      clientCertPair: { crt: await readFile(cfg.tlsCertPath), key: await readFile(cfg.tlsKeyPath) },
    };
  else if (cfg.apiKey || cfg.tls) options.tls = true;
  if (cfg.apiKey) options.apiKey = cfg.apiKey;
  return options;
}

/** A client for the schedules this worker owns (R2-1 part B), connected as worker-core's connectTemporal is. */
export async function connectTemporal(cfg: TemporalConfig): Promise<Client> {
  const options: ConnectionOptions = { address: cfg.address };
  if (cfg.apiKey) {
    options.apiKey = cfg.apiKey;
    options.tls = true;
  } else if (cfg.tlsCertPath && cfg.tlsKeyPath) {
    options.tls = {
      clientCertPair: { crt: await readFile(cfg.tlsCertPath), key: await readFile(cfg.tlsKeyPath) },
    };
  } else if (cfg.tls) {
    options.tls = true;
  }
  const connection = await Connection.connect(options);
  return new Client({ connection, namespace: cfg.namespace });
}
