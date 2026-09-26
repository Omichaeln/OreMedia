import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, sdkLogger } from './logger';

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
