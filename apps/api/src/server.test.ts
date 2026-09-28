import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { evaluateConfiguration } from '@oremedia/observability';
import { apiCapabilities } from './composition';
import { createServer, internalErrorFields } from './server';

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
  const get = async (degraded?: readonly string[]) => {
    const server = createServer(degraded ? { degraded } : {}).listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
      return { status: res.status, text: await res.text() };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  it('keeps 200 and ok, and lists no degraded capability by default', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true, degraded: [] });
  });

  it("lists the api's degraded capabilities by name only: no setting name, no value", async () => {
    const env = {
      WEB_ORIGIN: 'https://app.example.com',
      OBJECT_STORE_BUCKET_ASSETS: 'bucket-value',
      PROVIDER_X_CLIENT_ID_REF: 'client-id-value',
      PROVIDER_X_SECRET_REF: 'client-secret-value',
    };
    const report = evaluateConfiguration(apiCapabilities(), env);
    expect(report.degraded).toContain('uploads');
    expect(report.degraded).not.toContain('web_origin');
    expect(report.degraded).not.toContain('channel:x');
    expect(report.degraded.some((c) => c.startsWith('channel:'))).toBe(true);
    const res = await get(report.degraded);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true, degraded: report.degraded });
    expect(res.text).not.toMatch(/OBJECT_STORE|PROVIDER_|WEB_ORIGIN|_REF|value|example/);
  });
});
