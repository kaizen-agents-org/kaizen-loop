import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { configSchema } from '../src/config/schema.js';

describe('configSchema', () => {
  it('applies defaults for valid minimal config', () => {
    const config = configSchema.parse({ version: 1 });

    expect(config.agent.default).toBe('claude');
    expect(config.commands.verify).toEqual([]);
    expect(config.builder.resultPath).toBe('.kaizen/builder/build-result.json');
    expect(config.verifier.enabled).toBe(true);
    expect(config.verifier.command).toBe('verifier');
    expect(config.guardian.enabled).toBe(true);
    expect(config.guardian.command).toBe('codex');
    expect(config.run.issueTimeoutMinutes).toBe(120);
    expect(config.scheduler.nightly).toEqual({ enabled: true, time: '02:00' });
    expect(config.scheduler.poll).toEqual({ enabled: false, intervalMinutes: 5, skipIfRunning: true });
    expect(config.policy.mode).toBe('hybrid');
    expect(config.issues.priorityOrder).toEqual(['kaizen:P0', 'kaizen:P1', 'kaizen:P2']);
  });

  it('rejects unknown keys', () => {
    expect(() => configSchema.parse({ version: 1, typo: true })).toThrow();
    expect(() => configSchema.parse({ version: 1, run: { maxIssuesPerNight: 1, typo: true } })).toThrow();
  });

  it('rejects invalid scheduler values', () => {
    expect(() => configSchema.parse({ version: 1, scheduler: { nightly: { time: '24:00' } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { nightly: { time: '02:60' } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { poll: { intervalMinutes: 60 } } })).toThrow();
  });

  it('parses generated yaml shape', () => {
    const config = configSchema.parse(
      parse(`
version: 1
agent:
  default: claude
commands:
  setup: npm ci
  verify:
    - npm test
`)
    );

    expect(config.commands.setup).toBe('npm ci');
    expect(config.commands.verify).toEqual(['npm test']);
  });
});
