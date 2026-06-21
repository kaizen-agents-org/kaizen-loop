import fs from 'node:fs';
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
    expect(config.goal.maxIterations).toBe(5);
    expect(config.goal.issueLabel).toBe('kaizen:goal');
    expect(config.goal.evaluation).toEqual({ command: null, timeoutMinutes: 15 });
    expect(config.goal.agent).toEqual({
      command: 'codex',
      args: ['exec', '--sandbox', 'read-only', '-'],
      resultPath: 'goal-result.json',
      timeoutMinutes: 20
    });
    expect(config.run.issueTimeoutMinutes).toBe(120);
    expect(config.run.maxOpenPullRequests).toBe(1);
    expect(config.scheduler.nightly).toEqual({ enabled: true, time: '02:00' });
    expect(config.scheduler.afternoon).toEqual({ enabled: false, time: '14:00' });
    expect(config.scheduler.poll).toEqual({ enabled: false, intervalMinutes: 5, skipIfRunning: true });
    expect(config.policy.mode).toBe('pr-only');
    expect(config.issues.priorityOrder).toEqual(['kaizen:P0', 'kaizen:P1', 'kaizen:P2']);
  });

  it('rejects unknown keys', () => {
    expect(() => configSchema.parse({ version: 1, typo: true })).toThrow();
    expect(() => configSchema.parse({ version: 1, run: { maxIssuesPerNight: 1, typo: true } })).toThrow();
  });

  it('rejects invalid scheduler values', () => {
    expect(() => configSchema.parse({ version: 1, scheduler: { nightly: { time: '24:00' } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { nightly: { time: '02:60' } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { afternoon: { time: '24:00' } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { afternoon: { time: '14:60' } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { poll: { intervalMinutes: 60 } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, run: { maxOpenPullRequests: -1 } })).toThrow();
  });

  it('accepts the afternoon scheduler slot', () => {
    const config = configSchema.parse({
      version: 1,
      scheduler: {
        afternoon: { enabled: true, time: '14:30' }
      }
    });

    expect(config.scheduler.afternoon).toEqual({ enabled: true, time: '14:30' });
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

  it('documents that this repository overrides generated agent defaults to codex', () => {
    const repoConfig = parse(fs.readFileSync('.kaizen/config.yml', 'utf8'));
    const cliSpec = fs.readFileSync('docs/02-cli-spec.md', 'utf8');
    const configSpec = fs.readFileSync('docs/03-config-spec.md', 'utf8');

    expect(repoConfig.agent.default).toBe('codex');
    expect(cliSpec).toMatch(/agent\.default:\s*codex/);
    expect(cliSpec).toMatch(/生成時のデフォルト:\s*claude/);
    expect(configSpec).toMatch(/agent\.default:\s*codex/);
    expect(configSpec).toMatch(/生成時のデフォルト値/);
  });
});
