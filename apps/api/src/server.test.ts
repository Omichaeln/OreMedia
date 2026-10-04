import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { evaluateConfiguration } from '@oremedia/observability';
import { apiCapabilities } from './composition';
import { createServer, internalErrorFields, revisionFromEnv, type ServerOptions } from './server';

describe('internalErrorFields (spec 17.3: driver messages carry user data)', () => {
  it('keeps name, code and errno but elides quoted values from the message', () => {
    const err = Object.assign(
      new Error("Duplicate entry 'ten_1-someone@example.test' for key 'memberships.uq_invited'"),
      { code: 'ER_DUP_ENTRY', errno: 1062 },
    );
    expect(internalErrorFields(err)).toEqual({
      errorName: 'Error',
      errorCode: 'ER_DUP_ENTRY',
      errno: 1062,
      errorMessage: 'Duplicate entry … for key …',
    });
  });

  it('elides double-quoted values too and tolerates non-errors', () => {
    expect(internalErrorFields(new Error('column "email" has value "a@b.c"')).errorMessage).toBe(
      'column … has value …',
    );
    expect(internalErrorFields('plain "text"')).toEqual({ errorName: 'NonError', errorMessage: 'plain …' });
  });
});

describe('/health and the startup configuration report', () => {
  const get = async (degraded?: readonly string[], opts: ServerOptions = {}) => {
    const server = createServer(degraded ? { ...opts, degraded } : opts).listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
      return { status: res.status, text: await res.text() };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  it('keeps 200 and ok, and lists no degraded capability and no revision by default', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true, degraded: [], revision: null });
  });

  it('reports the deployed revision next to the existing fields', async () => {
    const res = await get(['uploads'], { revision: 'f3ba12f0c0ffee' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true, degraded: ['uploads'], revision: 'f3ba12f0c0ffee' });
  });

  it('takes the revision from RAILWAY_GIT_COMMIT_SHA, then OREMEDIA_VERSION, else null', () => {
    expect(revisionFromEnv({ RAILWAY_GIT_COMMIT_SHA: 'abc123', OREMEDIA_VERSION: '0.1.0' })).toBe('abc123');
    expect(revisionFromEnv({ RAILWAY_GIT_COMMIT_SHA: ' ', OREMEDIA_VERSION: '0.1.0' })).toBe('0.1.0');
    expect(revisionFromEnv({ OREMEDIA_VERSION: '' })).toBeNull();
    expect(revisionFromEnv({})).toBeNull();
  });

  it("lists the api's degraded capabilities by name only: no setting name, no value", async () => {
    const env = {
      WEB_ORIGIN: 'https://app.example.com',
      OBJECT_STORE_BUCKET_ASSETS: 'bucket-value',
      PROVIDER_X_CLIENT_ID_REF: 'client-id-value',
      PROVIDER_X_SECRET_REF: 'client-secret-value',
    };
    const report = evaluateConfiguration(apiCapabilities(env), env);
    expect(report.degraded).toContain('uploads');
    expect(report.degraded).not.toContain('web_origin');
    expect(report.degraded).not.toContain('channel:x');
    expect(report.degraded.some((c) => c.startsWith('channel:'))).toBe(true);
    const res = await get(report.degraded);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true, degraded: report.degraded, revision: null });
    expect(res.text).not.toMatch(/OBJECT_STORE|PROVIDER_|WEB_ORIGIN|_REF|value|example/);
  });
});
