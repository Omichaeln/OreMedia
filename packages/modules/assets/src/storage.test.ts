import { describe, expect, it } from 'vitest';
import { PolicyDeniedError, TenantContextMissingError } from '@oremedia/contracts/errors';
import { runInTenant, type TenantContext } from '@oremedia/db';
import {
  attachmentDisposition,
  MemoryStorageProvider,
  S3StorageProvider,
  assertTenantKey,
  createStorageFromEnv,
  objectStoreMissingSettings,
  parseStorageKey,
  readS3Config,
  storageKeys,
  uploadsCapability,
} from './storage';

const A = 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAA';
const B = 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAB';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: 'usr_1' },
  brandIds: 'all',
  correlationId: 'corr_storage',
});

describe('storage keys (spec 9.1)', () => {
  it('every builder prefixes the tenant', () => {
    expect(storageKeys.quarantine(A, 'ui_1')).toBe(`quarantine/${A}/ui_1`);
    expect(storageKeys.quarantine(A, 'ui_1', 'sanitised')).toBe(`quarantine/${A}/ui_1/sanitised`);
    expect(storageKeys.original(A, 'brd_1', 'ast_1', 'av_1')).toBe(`assets/${A}/brd_1/ast_1/av_1/original`);
    expect(storageKeys.derivative(A, 'brd_1', 'ast_1', 'av_1', 'thumbnail')).toBe(
      `assets/${A}/brd_1/ast_1/av_1/thumbnail`,
    );
    expect(storageKeys.release(A, 'brd_1', 'av_1', 'web', 'ad_1')).toBe(`releases/${A}/brd_1/av_1/web/ad_1`);
  });
  it('parses valid keys and refuses traversal, unknown prefixes and absolute paths', () => {
    expect(parseStorageKey(`assets/${A}/brd_1/ast_1/av_1/original`)).toEqual({
      prefix: 'assets',
      tenantId: A,
    });
    expect(parseStorageKey(`quarantine/${A}/../${B}/x`)).toBeNull();
    expect(parseStorageKey(`/assets/${A}/x`)).toBeNull();
    expect(parseStorageKey(`public/${A}/x`)).toBeNull();
    expect(parseStorageKey(`assets/${A}`)).toBeNull();
    expect(parseStorageKey(`assets//x`)).toBeNull();
  });
  it('assertTenantKey needs tenant context and refuses foreign or malformed keys', async () => {
    expect(() => assertTenantKey(`assets/${A}/x`)).toThrow(TenantContextMissingError);
    await runInTenant(ctx(A), async () => {
      expect(assertTenantKey(`assets/${A}/x`)).toEqual({ prefix: 'assets', tenantId: A });
      expect(() => assertTenantKey(`assets/${B}/x`)).toThrow(PolicyDeniedError);
      try {
        assertTenantKey(`assets/${B}/x`);
      } catch (err) {
        expect((err as PolicyDeniedError).reason).toBe('storage_key_tenant_mismatch');
      }
      try {
        assertTenantKey(`assets/${A}/../${B}/x`);
      } catch (err) {
        expect((err as PolicyDeniedError).reason).toBe('storage_key_malformed');
      }
    });
  });
});

describe('MemoryStorageProvider enforces the tenant prefix on every operation', () => {
  it("refuses another tenant's prefix before touching any object", async () => {
    const s = new MemoryStorageProvider();
    await runInTenant(ctx(B), () =>
      s.putObject(`quarantine/${B}/ui_b`, Buffer.from('b'), { contentType: 'text/plain' }),
    );
    await runInTenant(ctx(A), async () => {
      const own = `quarantine/${A}/ui_a`;
      await s.putObject(own, Buffer.from('a'), { contentType: 'text/plain' });
      expect(await s.headObject(own)).toEqual({ bytes: 1, contentType: 'text/plain' });
      expect((await s.getObject(own))?.toString()).toBe('a');
      const foreign = `quarantine/${B}/ui_b`;
      await expect(s.getObject(foreign)).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(s.headObject(foreign)).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(
        s.putObject(foreign, Buffer.from('x'), { contentType: 'text/plain' }),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(s.copyObject(own, `assets/${B}/brd/ast/av/original`)).rejects.toBeInstanceOf(
        PolicyDeniedError,
      );
      await expect(s.copyObject(foreign, `assets/${A}/brd/ast/av/original`)).rejects.toBeInstanceOf(
        PolicyDeniedError,
      );
      await expect(s.deleteObject(foreign)).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(s.signDownloadUrl(foreign, { expiresInSec: 60 })).rejects.toBeInstanceOf(
        PolicyDeniedError,
      );
      await expect(
        s.signUploadUrl(foreign, { contentType: 'text/plain', expiresInSec: 60 }),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      // Nothing of B's was touched.
      expect(s.has(foreign)).toBe(true);
      expect((await runInTenant(ctx(B), () => s.getObject(foreign)))?.toString()).toBe('b');
    });
  });
  it('signs URLs with an explicit expiry and serves byte ranges', async () => {
    const s = new MemoryStorageProvider();
    await runInTenant(ctx(A), async () => {
      const key = `assets/${A}/brd/ast/av/original`;
      await s.putObject(key, Buffer.from('0123456789'), { contentType: 'text/plain' });
      const signed = await s.signDownloadUrl(key, { expiresInSec: 300 });
      expect(signed.url).toContain(key);
      expect(signed.expiresAt.getTime() - Date.now()).toBeGreaterThan(290_000);
      expect((await s.getObject(key, { start: 2, end: 4 }))?.toString()).toBe('234');
    });
  });
});

describe('createStorageFromEnv (spec 9.1: no local storage in production)', () => {
  it('fails at startup in production without object store configuration', () => {
    expect(() => createStorageFromEnv({ NODE_ENV: 'production' })).toThrow(/not permitted in production/);
  });
  it('builds the S3 provider from OBJECT_STORE_* and routes releases to the releases bucket', async () => {
    const env = {
      NODE_ENV: 'production',
      OBJECT_STORE_BUCKET_ASSETS: 'oremedia-assets',
      OBJECT_STORE_BUCKET_RELEASES: 'oremedia-releases',
      OBJECT_STORE_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      OBJECT_STORE_ACCESS_KEY_ID: 'test',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'test',
    };
    expect(readS3Config(env)).toMatchObject({
      region: 'auto',
      buckets: { assets: 'oremedia-assets', releases: 'oremedia-releases' },
    });
    const s = createStorageFromEnv(env);
    expect(s).toBeInstanceOf(S3StorageProvider);
    const s3 = s as S3StorageProvider;
    expect(s3.bucketForKey(`assets/${A}/x/y/z/original`)).toBe('oremedia-assets');
    expect(s3.bucketForKey(`quarantine/${A}/ui`)).toBe('oremedia-assets');
    expect(s3.bucketForKey(`releases/${A}/brd/av/web/ad`)).toBe('oremedia-releases');
    // Presigning is local: no network. The URL is bucket-scoped, tenant-checked and carries the expiry.
    await runInTenant(ctx(A), async () => {
      const put = await s3.signUploadUrl(`quarantine/${A}/ui_1`, {
        contentType: 'image/png',
        expiresInSec: 3600,
      });
      expect(put.url).toContain('oremedia-assets');
      expect(put.url).toContain(`quarantine/${A}/ui_1`);
      expect(put.url).toContain('X-Amz-Expires=3600');
      // BSC-4: a declared size is part of the signature, so a larger body is refused by the store.
      const sized = await s3.signUploadUrl(`quarantine/${A}/ui_2`, {
        contentType: 'application/pdf',
        expiresInSec: 600,
        contentLength: 1234,
      });
      expect(new URL(sized.url).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
      const get = await s3.signDownloadUrl(`releases/${A}/brd/av/web/ad`, { expiresInSec: 300 });
      expect(get.url).toContain('oremedia-releases');
      expect(get.url).toContain('X-Amz-Expires=300');
      await expect(
        s3.signDownloadUrl(`assets/${B}/x/y/z/original`, { expiresInSec: 300 }),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      // BSC-2: a download is an attachment with its type, whatever the object was stored with.
      expect(get.url).not.toContain('response-content-disposition');
      const file = await s3.signDownloadUrl(`assets/${A}/brd/ast/av/original`, {
        expiresInSec: 300,
        download: { filename: 'Oré logo.svg', contentType: 'image/svg+xml' },
      });
      const q = new URL(file.url).searchParams;
      expect(q.get('response-content-disposition')).toBe(
        `attachment; filename="Or_ logo.svg"; filename*=UTF-8''Or%C3%A9%20logo.svg`,
      );
      expect(q.get('response-content-type')).toBe('image/svg+xml');
      expect(attachmentDisposition("Logo (v2)*'s.svg")).toBe(
        `attachment; filename="Logo (v2)*'s.svg"; filename*=UTF-8''Logo%20%28v2%29%2A%27s.svg`,
      );
    });
  });
  it('falls back to memory outside production', () => {
    expect(createStorageFromEnv({ NODE_ENV: 'test' })).toBeInstanceOf(MemoryStorageProvider);
  });
});

describe('uploads capability (startup configuration report)', () => {
  const full = {
    OBJECT_STORE_BUCKET_ASSETS: 'a',
    OBJECT_STORE_BUCKET_RELEASES: 'r',
    OBJECT_STORE_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    OBJECT_STORE_ACCESS_KEY_ID: 'id-value',
    OBJECT_STORE_SECRET_ACCESS_KEY: 'secret-value',
  };

  it('is configured exactly when the reader has a store and the access key pair is set', () => {
    expect(uploadsCapability.capability).toBe('uploads');
    expect(objectStoreMissingSettings(full)).toEqual([]);
    expect(readS3Config(full)).not.toBeNull();
    const { OBJECT_STORE_ENDPOINT: _endpoint, ...regionOnly } = full;
    expect(objectStoreMissingSettings({ ...regionOnly, OBJECT_STORE_REGION: 'eu-west-1' })).toEqual([]);
  });

  it('names every missing setting (the production gap: nothing set) and never a value', () => {
    expect(objectStoreMissingSettings({})).toEqual([
      'OBJECT_STORE_BUCKET_ASSETS',
      'OBJECT_STORE_BUCKET_RELEASES',
      'OBJECT_STORE_ENDPOINT',
      'OBJECT_STORE_ACCESS_KEY_ID',
      'OBJECT_STORE_SECRET_ACCESS_KEY',
    ]);
    // Buckets and endpoint without keys: readS3Config builds a client, yet the store refuses every signed URL.
    const { OBJECT_STORE_ACCESS_KEY_ID: _id, OBJECT_STORE_SECRET_ACCESS_KEY: _secret, ...noKeys } = full;
    expect(readS3Config(noKeys)).not.toBeNull();
    const missing = uploadsCapability.missing(noKeys);
    expect(missing).toEqual(['OBJECT_STORE_ACCESS_KEY_ID', 'OBJECT_STORE_SECRET_ACCESS_KEY']);
    expect(
      JSON.stringify(uploadsCapability.missing({ ...full, OBJECT_STORE_BUCKET_ASSETS: '' })),
    ).not.toMatch(/value|example/);
  });
});
