import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { requireTenant } from '@oremedia/db';
import { logger, type CapabilityCheck } from '@oremedia/observability';

/**
 * Spec 9.1 / 20.2: the storage abstraction ported as a pattern from the reference upload interface, with tenant-prefixed
 * keys enforced by the implementation, `headObject`/`copyObject`/`deleteObject` added and no local-disk storage in
 * production. Every key is `quarantine/{tenant}/...`, `assets/{tenant}/{brand}/{asset}/{version}/...` or
 * `releases/{tenant}/...`; a key that does not carry the *current* tenant's prefix is refused before any I/O.
 */
export type StoragePrefix = 'quarantine' | 'assets' | 'releases';

export interface StorageObjectHead {
  bytes: number;
  contentType: string | null;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

/** Inclusive byte range, as in HTTP Range. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * BSC-2: a signed GET that the browser saves rather than shows: the store answers with `Content-Disposition:
 * attachment` and this content type, whatever the object was stored with.
 */
export interface DownloadDisposition {
  filename: string;
  contentType: string;
}

export interface SignedDownloadOptions {
  expiresInSec: number;
  download?: DownloadDisposition;
}

/** RFC 6266 attachment header: an ASCII fallback name and the UTF-8 name. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // RFC 5987 attr-char excludes ' ( ) * which encodeURIComponent leaves as they are.
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface StorageProvider {
  signUploadUrl(key: string, opts: { contentType: string; expiresInSec: number }): Promise<SignedUrl>;
  signDownloadUrl(key: string, opts: SignedDownloadOptions): Promise<SignedUrl>;
  headObject(key: string): Promise<StorageObjectHead | null>;
  getObject(key: string, range?: ByteRange): Promise<Buffer | null>;
  putObject(key: string, body: Buffer, opts: { contentType: string }): Promise<void>;
  /**
   * STU-2a: the object (or an inclusive byte range of it) as a stream, for objects too large to hold in memory
   * (video and audio up to the upload caps). Null when the object does not exist.
   */
  getObjectStream(key: string, range?: ByteRange): Promise<Readable | null>;
  /**
   * STU-2a: writes a stream of unknown length. Bodies larger than one part go up as a multipart upload in parts of
   * equal size (R2 requires it), so memory holds one part at a time; a failed upload is aborted, never left dangling.
   */
  putObjectStream(key: string, body: Readable, opts: { contentType: string }): Promise<{ bytes: number }>;
  copyObject(fromKey: string, toKey: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

/** Multipart part size: every part but the last has exactly this size (S3 minimum 5 MiB; R2 wants equal parts). */
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

/**
 * Re-chunks a stream into buffers of exactly `size` bytes (the last may be shorter). Holds at most one part plus one
 * incoming chunk in memory.
 */
export async function* chunkStream(
  body: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  size: number,
): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const raw of body) {
    let chunk =
      typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    while (chunk.length > 0) {
      const take = Math.min(size - pendingBytes, chunk.length);
      pending.push(chunk.subarray(0, take));
      pendingBytes += take;
      chunk = chunk.subarray(take);
      if (pendingBytes === size) {
        yield Buffer.concat(pending, size);
        pending = [];
        pendingBytes = 0;
      }
    }
  }
  if (pendingBytes > 0) yield Buffer.concat(pending, pendingBytes);
}

/** SHA-256 and length of a stored object, read as a stream (never loaded whole). Null when it does not exist. */
export async function hashStoredObject(
  store: StorageProvider,
  key: string,
  onProgress?: (bytes: number) => void,
): Promise<{ contentHash: string; bytes: number } | null> {
  const stream = await store.getObjectStream(key);
  if (!stream) return null;
  const hash = createHash('sha256');
  let bytes = 0;
  let reported = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
    if (onProgress && bytes - reported >= MULTIPART_PART_BYTES) {
      reported = bytes;
      onProgress(bytes);
    }
  }
  return { contentHash: hash.digest('hex'), bytes };
}

/** Key builders: the only way keys are made, so the prefix and tenant segment can never be omitted. */
export const storageKeys = {
  /** The presigned PUT target (spec 9.1) and, with `part`, the pipeline's intermediate objects. */
  quarantine: (tenantId: string, intentId: string, part?: string): string =>
    part ? `quarantine/${tenantId}/${intentId}/${part}` : `quarantine/${tenantId}/${intentId}`,
  original: (tenantId: string, brandId: string, assetId: string, versionId: string): string =>
    `assets/${tenantId}/${brandId}/${assetId}/${versionId}/original`,
  derivative: (
    tenantId: string,
    brandId: string,
    assetId: string,
    versionId: string,
    purpose: string,
  ): string => `assets/${tenantId}/${brandId}/${assetId}/${versionId}/${purpose}`,
  release: (tenantId: string, brandId: string, versionId: string, purpose: string, nonce: string): string =>
    `releases/${tenantId}/${brandId}/${versionId}/${purpose}/${nonce}`,
};

const KEY_PATTERN = /^(quarantine|assets|releases)\/([A-Za-z0-9_]+)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

export function parseStorageKey(key: string): { prefix: StoragePrefix; tenantId: string } | null {
  const m = KEY_PATTERN.exec(key);
  if (!m || key.includes('..')) return null;
  return { prefix: m[1] as StoragePrefix, tenantId: m[2] as string };
}

/** Refuses a malformed key or one carrying another tenant's prefix. Requires tenant context (spec 5.2). */
export function assertTenantKey(key: string): { prefix: StoragePrefix; tenantId: string } {
  const parsed = parseStorageKey(key);
  if (!parsed) throw new PolicyDeniedError('storage_key_malformed', 'Storage key is not valid');
  const { tenantId } = requireTenant();
  if (parsed.tenantId !== tenantId)
    throw new PolicyDeniedError('storage_key_tenant_mismatch', 'Storage key belongs to another tenant');
  return parsed;
}

/** Template base: every public operation checks the key against the current tenant, then delegates. Methods are
 *  async so a refused key is always a rejection, never a synchronous throw from a Promise-returning API. */
abstract class TenantPrefixedStorage implements StorageProvider {
  async signUploadUrl(key: string, opts: { contentType: string; expiresInSec: number }): Promise<SignedUrl> {
    assertTenantKey(key);
    return this.doSignUploadUrl(key, opts);
  }
  async signDownloadUrl(key: string, opts: SignedDownloadOptions): Promise<SignedUrl> {
    assertTenantKey(key);
    return this.doSignDownloadUrl(key, opts);
  }
  async headObject(key: string): Promise<StorageObjectHead | null> {
    assertTenantKey(key);
    return this.doHeadObject(key);
  }
  async getObject(key: string, range?: ByteRange): Promise<Buffer | null> {
    assertTenantKey(key);
    return this.doGetObject(key, range);
  }
  async putObject(key: string, body: Buffer, opts: { contentType: string }): Promise<void> {
    assertTenantKey(key);
    return this.doPutObject(key, body, opts);
  }
  async getObjectStream(key: string, range?: ByteRange): Promise<Readable | null> {
    assertTenantKey(key);
    return this.doGetObjectStream(key, range);
  }
  async putObjectStream(
    key: string,
    body: Readable,
    opts: { contentType: string },
  ): Promise<{ bytes: number }> {
    assertTenantKey(key);
    return this.doPutObjectStream(key, body, opts);
  }
  async copyObject(fromKey: string, toKey: string): Promise<void> {
    assertTenantKey(fromKey);
    assertTenantKey(toKey);
    return this.doCopyObject(fromKey, toKey);
  }
  async deleteObject(key: string): Promise<void> {
    assertTenantKey(key);
    return this.doDeleteObject(key);
  }

  protected abstract doSignUploadUrl(
    key: string,
    opts: { contentType: string; expiresInSec: number },
  ): Promise<SignedUrl>;
  protected abstract doSignDownloadUrl(key: string, opts: SignedDownloadOptions): Promise<SignedUrl>;
  protected abstract doHeadObject(key: string): Promise<StorageObjectHead | null>;
  protected abstract doGetObject(key: string, range?: ByteRange): Promise<Buffer | null>;
  protected abstract doPutObject(key: string, body: Buffer, opts: { contentType: string }): Promise<void>;
  protected abstract doGetObjectStream(key: string, range?: ByteRange): Promise<Readable | null>;
  protected abstract doPutObjectStream(
    key: string,
    body: Readable,
    opts: { contentType: string },
  ): Promise<{ bytes: number }>;
  protected abstract doCopyObject(fromKey: string, toKey: string): Promise<void>;
  protected abstract doDeleteObject(key: string): Promise<void>;
}

export interface S3StorageConfig {
  /** R2 or any S3-compatible endpoint; omitted for AWS S3 proper. */
  endpoint?: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  buckets: { assets: string; releases: string };
  forcePathStyle?: boolean;
  /** Multipart part size for putObjectStream (tests use a small one); default MULTIPART_PART_BYTES. */
  partBytes?: number;
}

const isNotFound = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
};

/** AWS SDK v3 provider; works for Cloudflare R2 via `OBJECT_STORE_ENDPOINT`. Buckets are private; access is presigned. */
export class S3StorageProvider extends TenantPrefixedStorage {
  private readonly client: S3Client;
  constructor(
    private readonly cfg: S3StorageConfig,
    client?: S3Client,
  ) {
    super();
    this.client =
      client ??
      new S3Client({
        region: cfg.region,
        ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
        forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
        ...(cfg.accessKeyId && cfg.secretAccessKey
          ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }
          : {}),
      });
  }

  /** Release derivatives live in the releases bucket (spec 9.3); everything else in the assets bucket. */
  bucketForKey(key: string): string {
    return key.startsWith('releases/') ? this.cfg.buckets.releases : this.cfg.buckets.assets;
  }

  protected async doSignUploadUrl(key: string, opts: { contentType: string; expiresInSec: number }) {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucketForKey(key), Key: key, ContentType: opts.contentType }),
      { expiresIn: opts.expiresInSec },
    );
    return { url, expiresAt: new Date(Date.now() + opts.expiresInSec * 1000) };
  }
  protected async doSignDownloadUrl(key: string, opts: SignedDownloadOptions) {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucketForKey(key),
        Key: key,
        ...(opts.download
          ? {
              ResponseContentDisposition: attachmentDisposition(opts.download.filename),
              ResponseContentType: opts.download.contentType,
            }
          : {}),
      }),
      { expiresIn: opts.expiresInSec },
    );
    return { url, expiresAt: new Date(Date.now() + opts.expiresInSec * 1000) };
  }
  protected async doHeadObject(key: string) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucketForKey(key), Key: key }));
      return { bytes: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
  protected async doGetObject(key: string, range?: ByteRange) {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketForKey(key),
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
  protected async doPutObject(key: string, body: Buffer, opts: { contentType: string }) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketForKey(key),
        Key: key,
        Body: body,
        ContentType: opts.contentType,
      }),
    );
  }
  protected async doGetObjectStream(key: string, range?: ByteRange) {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketForKey(key),
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      if (!res.Body) return null;
      // In Node the SDK's body is an http.IncomingMessage (a Readable) mixed with its helpers.
      return res.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
  protected async doPutObjectStream(key: string, body: Readable, opts: { contentType: string }) {
    const Bucket = this.bucketForKey(key);
    const parts = chunkStream(body, this.cfg.partBytes ?? MULTIPART_PART_BYTES);
    const first = await parts.next();
    const firstPart = first.done ? Buffer.alloc(0) : first.value;
    const second = first.done ? first : await parts.next();
    if (second.done) {
      // One part or less: a plain PUT (multipart needs at least one full part before the last).
      await this.client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: firstPart, ContentType: opts.contentType }),
      );
      return { bytes: firstPart.length };
    }
    const created = await this.client
      .send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: opts.contentType }))
      .catch((err: unknown) => {
        body.destroy();
        throw err;
      });
    const UploadId = created.UploadId;
    if (!UploadId) throw new Error(`multipart upload not created for ${key}`);
    const done: Array<{ ETag: string; PartNumber: number }> = [];
    let bytes = 0;
    try {
      const upload = async (part: Buffer) => {
        const PartNumber = done.length + 1;
        const res = await this.client.send(
          new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber, Body: part }),
        );
        done.push({ ETag: res.ETag ?? '', PartNumber });
        bytes += part.length;
      };
      await upload(firstPart);
      await upload(second.value);
      for await (const part of parts) await upload(part);
      await this.client.send(
        new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId, MultipartUpload: { Parts: done } }),
      );
      return { bytes };
    } catch (err) {
      // The source stops too (a file or upstream stream is not left open behind a failed upload).
      body.destroy();
      await this.client
        .send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId }))
        .catch((abortErr: unknown) =>
          logger().warn(
            { errorName: (abortErr as Error | undefined)?.name ?? 'unknown' },
            'multipart upload abort failed; the bucket lifecycle rule removes it',
          ),
        );
      throw err;
    }
  }
  protected async doCopyObject(fromKey: string, toKey: string) {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucketForKey(toKey),
        Key: toKey,
        CopySource: `${this.bucketForKey(fromKey)}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
      }),
    );
  }
  protected async doDeleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketForKey(key), Key: key }));
  }
}

/** Test double with the same tenant enforcement. Never used in production (createStorageFromEnv refuses). */
export class MemoryStorageProvider extends TenantPrefixedStorage {
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  /** Test helper: keys currently stored (across tenants; the enforcement is on the operations). */
  keys(): string[] {
    return [...this.objects.keys()];
  }
  has(key: string): boolean {
    return this.objects.has(key);
  }

  protected async doSignUploadUrl(key: string, opts: { contentType: string; expiresInSec: number }) {
    const expiresAt = new Date(Date.now() + opts.expiresInSec * 1000);
    return { url: `memory://upload/${key}?expires=${expiresAt.getTime()}`, expiresAt };
  }
  protected async doSignDownloadUrl(key: string, opts: SignedDownloadOptions) {
    const expiresAt = new Date(Date.now() + opts.expiresInSec * 1000);
    const download = opts.download
      ? `&response-content-disposition=${encodeURIComponent(attachmentDisposition(opts.download.filename))}&response-content-type=${encodeURIComponent(opts.download.contentType)}`
      : '';
    return { url: `memory://download/${key}?expires=${expiresAt.getTime()}${download}`, expiresAt };
  }
  protected async doHeadObject(key: string) {
    const o = this.objects.get(key);
    return o ? { bytes: o.body.length, contentType: o.contentType } : null;
  }
  protected async doGetObject(key: string, range?: ByteRange) {
    const o = this.objects.get(key);
    if (!o) return null;
    return range ? o.body.subarray(range.start, range.end + 1) : o.body;
  }
  protected async doPutObject(key: string, body: Buffer, opts: { contentType: string }) {
    this.objects.set(key, { body: Buffer.from(body), contentType: opts.contentType });
  }
  protected async doGetObjectStream(key: string, range?: ByteRange) {
    const bytes = await this.doGetObject(key, range);
    if (!bytes) return null;
    // Served in small chunks so consumers see a real stream (several chunks), as from the store.
    return Readable.from(chunkStream([bytes], 64 * 1024));
  }
  protected async doPutObjectStream(key: string, body: Readable, opts: { contentType: string }) {
    const parts: Buffer[] = [];
    for await (const part of chunkStream(body, MULTIPART_PART_BYTES)) parts.push(part);
    const all = Buffer.concat(parts);
    this.objects.set(key, { body: all, contentType: opts.contentType });
    return { bytes: all.length };
  }
  protected async doCopyObject(fromKey: string, toKey: string) {
    const o = this.objects.get(fromKey);
    if (!o) throw new Error(`object not found: ${fromKey}`);
    this.objects.set(toKey, { body: Buffer.from(o.body), contentType: o.contentType });
  }
  protected async doDeleteObject(key: string) {
    this.objects.delete(key);
  }
}

type Env = Record<string, string | undefined>;

/** The object store settings readS3Config reads (Appendix A names); the configuration report checks these same names. */
export const OBJECT_STORE_SETTINGS = {
  bucketAssets: 'OBJECT_STORE_BUCKET_ASSETS',
  bucketReleases: 'OBJECT_STORE_BUCKET_RELEASES',
  endpoint: 'OBJECT_STORE_ENDPOINT',
  region: 'OBJECT_STORE_REGION',
  accessKeyId: 'OBJECT_STORE_ACCESS_KEY_ID',
  secretAccessKey: 'OBJECT_STORE_SECRET_ACCESS_KEY',
} as const;
const S = OBJECT_STORE_SETTINGS;

export function readS3Config(env: Env): S3StorageConfig | null {
  const assets = env[S.bucketAssets];
  const releases = env[S.bucketReleases];
  const endpoint = env[S.endpoint];
  const region = env[S.region];
  if (!assets || !releases || (!endpoint && !region)) return null;
  return {
    ...(endpoint ? { endpoint } : {}),
    region: region ?? 'auto',
    accessKeyId: env[S.accessKeyId],
    secretAccessKey: env[S.secretAccessKey],
    buckets: { assets, releases },
  };
}

/**
 * The object store settings a deployment lacks (names only). Beyond what readS3Config needs to build a client, the
 * access key pair is required: Railway has no ambient cloud credentials, so without it every signed URL is refused by
 * the store (R2 and S3 alike). The endpoint is named when neither it nor a region is set (R2 is the production store).
 */
export function objectStoreMissingSettings(env: Env): string[] {
  const missing: string[] = [];
  if (!env[S.bucketAssets]) missing.push(S.bucketAssets);
  if (!env[S.bucketReleases]) missing.push(S.bucketReleases);
  if (!env[S.endpoint] && !env[S.region]) missing.push(S.endpoint);
  if (!env[S.accessKeyId]) missing.push(S.accessKeyId);
  if (!env[S.secretAccessKey]) missing.push(S.secretAccessKey);
  return missing;
}

/** Configuration report capability: uploads, and every process that signs, reads or writes stored objects. */
export const uploadsCapability: CapabilityCheck = {
  capability: 'uploads',
  missing: objectStoreMissingSettings,
};

/**
 * Production requires the S3 configuration and fails at startup otherwise (spec 9.1: no local-disk storage in
 * production). Outside production an in-memory provider is used with a warning.
 */
export function createStorageFromEnv(env: Env = process.env): StorageProvider {
  const cfg = readS3Config(env);
  if (cfg) return new S3StorageProvider(cfg);
  if ((env['NODE_ENV'] ?? 'development') === 'production')
    throw new Error(
      'Object storage is not configured: set OBJECT_STORE_BUCKET_ASSETS, OBJECT_STORE_BUCKET_RELEASES and ' +
        'OBJECT_STORE_ENDPOINT (or OBJECT_STORE_REGION). Local and in-memory storage are not permitted in production (spec 9.1).',
    );
  logger().warn({}, 'object store not configured: using in-memory storage (non-production only)');
  return new MemoryStorageProvider();
}

let provider: StorageProvider | null = null;

/** Composition root hook (main and tests); a bare `storage()` call configures from the environment once. */
export function configureStorage(p: StorageProvider): void {
  provider = p;
}

export function storage(): StorageProvider {
  if (!provider) provider = createStorageFromEnv();
  return provider;
}
