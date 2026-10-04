import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, logEnvironment, sdkLogger } from './logger';

describe('log severity', () => {
  it('writes the level as its label, so the platform files an error as an error (Railway reads this field)', async () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger({ service: 'test', destination: dest, level: 'info' });
    log.info({}, 'started');
    log.warn({}, 'degraded');
    log.error({}, 'could not start');
    await new Promise((r) => setTimeout(r, 20));
    const levels = lines
      .join('')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { level: unknown }).level);
    expect(levels).toEqual(['info', 'warn', 'error']);
  });
});

describe('sdkLogger (Temporal SDK logs)', () => {
  it('keeps the SDK level, writes to the given stream, allowlists fields and reduces an error to its summary', async () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = sdkLogger(
      createLogger({ service: 'test', destination: dest, level: 'debug' }).child('temporal'),
    );
    log.info('Worker state changed', {
      sdkComponent: 'worker',
      taskQueue: 'ingest-metrics',
      state: 'DRAINING',
    });
    log.warn('Activity failed', {
      activityType: 'pullMetrics',
      error: new Error('boom'),
      payload: { secret: 'x' },
    });
    log.log('ERROR', 'Worker failed', { taskQueue: 'publishing' });
    log.trace('poll', {});
    await new Promise((r) => setTimeout(r, 20));
    const parsed = lines
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((p) => p['level'])).toEqual(['info', 'warn', 'error', 'debug']);
    expect(parsed[0]).toMatchObject({
      component: 'temporal',
      sdkComponent: 'worker',
      taskQueue: 'ingest-metrics',
      state: 'DRAINING',
      msg: 'Worker state changed',
    });
    expect(parsed[1]).toMatchObject({
      activityType: 'pullMetrics',
      errorName: 'Error',
      errorMessage: 'boom',
    });
    expect(parsed[1]).not.toHaveProperty('payload');
    expect(parsed[1]).not.toHaveProperty('error');
  });
});

describe('the env label', () => {
  const deployed = {
    NODE_ENV: 'production',
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    OREMEDIA_ENV: 'staging-eu',
  };

  it('prefers the caller, then OREMEDIA_ENV, then RAILWAY_ENVIRONMENT_NAME, then NODE_ENV, then development', () => {
    expect(logEnvironment('test', deployed)).toBe('test');
    expect(logEnvironment(undefined, deployed)).toBe('staging-eu');
    expect(logEnvironment(undefined, { ...deployed, OREMEDIA_ENV: undefined })).toBe('staging');
    expect(logEnvironment(undefined, { NODE_ENV: 'production' })).toBe('production');
    expect(logEnvironment(undefined, {})).toBe('development');
  });

  it('skips empty values, so a blank variable never hides the next one', () => {
    expect(logEnvironment('', { OREMEDIA_ENV: ' ', RAILWAY_ENVIRONMENT_NAME: 'staging' })).toBe('staging');
    expect(logEnvironment(undefined, { RAILWAY_ENVIRONMENT_NAME: '', NODE_ENV: '' })).toBe('development');
  });

  it("labels staging's lines staging although its image sets NODE_ENV=production", async () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const saved = { ...process.env };
    process.env['NODE_ENV'] = 'production';
    process.env['RAILWAY_ENVIRONMENT_NAME'] = 'staging';
    delete process.env['OREMEDIA_ENV'];
    try {
      createLogger({ service: 'test', destination: dest }).info({}, 'started');
    } finally {
      for (const k of ['NODE_ENV', 'RAILWAY_ENVIRONMENT_NAME', 'OREMEDIA_ENV'])
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(lines.join('').trim()) as Record<string, unknown>).toMatchObject({
      service: 'test',
      env: 'staging',
    });
  });
});
