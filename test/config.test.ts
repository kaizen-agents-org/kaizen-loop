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
    expect(config.safety.minFreeDiskMb).toBe(1024);
    expect(config.safety.wipLimit).toBe(5);
    expect(config.safety.envAllowlist).toContain('PATH');
    expect(config.safety.envAllowlist).toContain('KAIZEN_TMPDIR');
    expect(config.safety.envAllowlist).not.toContain('SECRET_TOKEN');
    expect(config.scheduler.jobs?.maintenance).toEqual({
      enabled: true,
      schedule: { type: 'daily', time: '02:00' },
      run: { mode: 'maintenance', lateStartGuard: true }
    });
    expect(config.scheduler.jobs?.['issue-watch']).toEqual({
      enabled: false,
      schedule: { type: 'interval', everyMinutes: 5 },
      run: { mode: 'watch', skipIfRunning: true }
    });
    expect(config.policy.mode).toBe('pr-only');
    expect(config.issues.priorityOrder).toEqual(['kaizen:P0', 'kaizen:P1', 'kaizen:P2']);
  });

  it('rejects unknown keys', () => {
    expect(() => configSchema.parse({ version: 1, typo: true })).toThrow();
    expect(() => configSchema.parse({ version: 1, run: { maxIssuesPerNight: 1, typo: true } })).toThrow();
  });

  it('rejects invalid scheduler values', () => {
    expect(() => configSchema.parse({ version: 1, scheduler: { nightly: { time: '02:00' } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { afternoon: { time: '14:00' } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { poll: { intervalMinutes: 5 } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { jobs: { bad: { schedule: { type: 'interval' }, run: { mode: 'maintenance' } } } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { jobs: { bad: { schedule: { type: 'interval', everyMinutes: 5, anchorTime: '02:00' }, run: { mode: 'maintenance' } } } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { jobs: { bad: { schedule: { type: 'daily', time: '24:00' }, run: { mode: 'maintenance' } } } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, scheduler: { jobs: { bad: { schedule: { type: 'times', times: [] }, run: { mode: 'maintenance' } } } } })).toThrow();
    expect(() => configSchema.parse({ version: 1, run: { maxOpenPullRequests: -1 } })).toThrow();
    expect(() => configSchema.parse({ version: 1, safety: { wipLimit: -1 } })).toThrow();
  });

  it('accepts a custom generated PR WIP limit', () => {
    const config = configSchema.parse({ version: 1, safety: { wipLimit: 7 } });

    expect(config.safety.wipLimit).toBe(7);
  });

  it('accepts scheduler jobs', () => {
    const config = configSchema.parse({
      version: 1,
      scheduler: {
        jobs: {
          maintenance: {
            schedule: { type: 'interval', everyHours: 8, anchorTime: '02:45' },
            run: { mode: 'maintenance', lateStartGuard: false }
          }
        }
      }
    });

    expect(config.scheduler.jobs?.maintenance).toEqual({
      enabled: true,
      schedule: { type: 'interval', everyHours: 8, anchorTime: '02:45' },
      run: { mode: 'maintenance', lateStartGuard: false }
    });
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
