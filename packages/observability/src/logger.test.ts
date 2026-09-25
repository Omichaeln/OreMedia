import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

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
