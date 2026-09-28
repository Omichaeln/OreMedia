import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  configStrict,
  evaluateConfiguration,
  reportConfiguration,
  type CapabilityCheck,
} from './config-report';
import { createLogger } from './logger';

const needs = (capability: string, ...names: string[]): CapabilityCheck => ({
  capability,
  missing: (env) => names.filter((n) => !env[n]),
});

const capture = () => {
  const lines: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  const log = createLogger({ service: 'test', destination: dest, level: 'info' });
  const parsed = async () => {
    await new Promise((r) => setTimeout(r, 20));
    return lines
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  return { log, parsed, raw: () => lines.join('') };
};

describe('evaluateConfiguration', () => {
  const checks = [needs('uploads', 'A_BUCKET', 'A_KEY'), needs('models', 'M_KEY')];

  it('lists degraded capabilities with the missing setting names, in check order', () => {
    expect(evaluateConfiguration(checks, { A_KEY: 'x' })).toEqual({
      degraded: ['uploads', 'models'],
      missing: { uploads: ['A_BUCKET'], models: ['M_KEY'] },
      refuse: false,
    });
  });

  it('a configured capability is absent; everything configured is an empty report', () => {
    expect(evaluateConfiguration(checks, { A_BUCKET: 'b', A_KEY: 'k', M_KEY: 'm' })).toEqual({
      degraded: [],
      missing: {},
      refuse: false,
    });
  });

  it('strict mode refuses only with OREMEDIA_CONFIG_STRICT=1 and something degraded', () => {
    expect(evaluateConfiguration(checks, { OREMEDIA_CONFIG_STRICT: '1' }).refuse).toBe(true);
    expect(
      evaluateConfiguration(checks, { OREMEDIA_CONFIG_STRICT: '1', A_BUCKET: 'b', A_KEY: 'k', M_KEY: 'm' })
        .refuse,
    ).toBe(false);
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1'])
      expect(configStrict({ OREMEDIA_CONFIG_STRICT: value })).toBe(false);
  });
});

describe('reportConfiguration (the one startup line)', () => {
  it('logs ONE error line naming capabilities and setting names, never a value', async () => {
    const { log, parsed, raw } = capture();
    const env = { A_KEY: 'value-that-must-not-appear', OTHER: 'also-secret' };
    const report = reportConfiguration(
      log,
      [needs('uploads', 'A_BUCKET', 'A_KEY'), needs('x', 'OTHER')],
      env,
    );
    const lines = await parsed();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      degraded: ['uploads'],
      missingSettings: { uploads: ['A_BUCKET'] },
      outcome: 'running',
    });
    expect(report.degraded).toEqual(['uploads']);
    expect(raw()).not.toContain('value-that-must-not-appear');
    expect(raw()).not.toContain('also-secret');
  });

  it('logs one info line when every capability is configured', async () => {
    const { log, parsed } = capture();
    reportConfiguration(log, [needs('uploads', 'A')], { A: 'set' });
    const lines = await parsed();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['level']).toBe('info');
  });

  it('warns once when OREMEDIA_CONFIG_STRICT holds anything but 1, and strict mode stays off', async () => {
    for (const value of ['true', 'yes', '0', ' 1']) {
      const { log, parsed, raw } = capture();
      const report = reportConfiguration(log, [needs('uploads', 'A')], { OREMEDIA_CONFIG_STRICT: value });
      expect(report.refuse).toBe(false);
      const lines = await parsed();
      expect(lines.map((l) => l['level'])).toEqual(['warn', 'error']);
      expect(lines[0]).toMatchObject({ flag: 'OREMEDIA_CONFIG_STRICT' });
      expect(String(lines[0]?.['msg'])).toContain('strict mode stays off');
      expect(raw()).not.toContain(`"${value}"`);
    }
    for (const env of [{}, { OREMEDIA_CONFIG_STRICT: '' }, { OREMEDIA_CONFIG_STRICT: '1' }]) {
      const { log, parsed } = capture();
      reportConfiguration(log, [needs('uploads', 'A')], { ...env, A: 'set' });
      expect((await parsed()).map((l) => l['level'])).toEqual(['info']);
    }
  });

  it('says it refuses in strict mode', async () => {
    const { log, parsed } = capture();
    const report = reportConfiguration(log, [needs('uploads', 'A')], { OREMEDIA_CONFIG_STRICT: '1' });
    expect(report.refuse).toBe(true);
    const [line] = await parsed();
    expect(line).toMatchObject({ level: 'error', outcome: 'refused' });
    expect(String(line?.['msg'])).toContain('refusing to start');
  });
});
