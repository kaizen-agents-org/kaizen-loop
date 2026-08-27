import { describe, expect, it } from 'vitest';
import { assertRunnerSupportedForLocalSync, executionConfig, migrateLegacyExecutionConfig } from '../src/config/execution.js';
import { configSchema } from '../src/config/schema.js';

describe('execution config', () => {
  it('keeps legacy and canonical builder plans equivalent', () => {
    const legacy = configSchema.parse({
      version: 1,
      agent: { default: 'codex', fallback: true, model: { codex: 'gpt-test', claude: 'claude-test' } },
      scheduler: { provider: 'launchd', jobs: {} }
    });
    const canonical = configSchema.parse({
      version: 1,
      execution: {
        runner: { provider: 'local' },
        builder: {
          primary: { provider: 'codex', model: 'gpt-test' },
          fallback: { provider: 'claude', model: 'claude-test' }
        }
      },
      scheduler: { jobs: {} }
    });

    expect(executionConfig(legacy)).toMatchObject({
      runner: executionConfig(canonical).runner,
      builder: executionConfig(canonical).builder
    });
  });

  it('fails closed before local sync for known but unsupported runners', () => {
    for (const provider of ['github-actions', 'codex-automation', 'claude-routine', 'cursor', 'external'] as const) {
      const config = configSchema.parse({ version: 1, execution: { runner: { provider } } });
      expect(() => assertRunnerSupportedForLocalSync(config)).toThrow(
        `scheduler sync does not support execution.runner.provider=${provider} yet`
      );
    }
  });

  it('allows local sync for canonical and legacy local schedulers', () => {
    expect(() => assertRunnerSupportedForLocalSync(configSchema.parse({
      version: 1,
      execution: { runner: { provider: 'local' } }
    }))).not.toThrow();
    expect(() => assertRunnerSupportedForLocalSync(configSchema.parse({
      version: 1,
      scheduler: { provider: 'cron', jobs: {} }
    }))).not.toThrow();
  });

  it('migrates idempotently without keeping legacy keys', () => {
    const raw: Record<string, unknown> = {
      version: 1,
      agent: { default: 'claude', fallback: true },
      scheduler: { provider: 'cron', jobs: {} }
    };

    expect(migrateLegacyExecutionConfig(raw)).toBe(true);
    expect(raw).not.toHaveProperty('agent');
    expect(raw.scheduler).not.toHaveProperty('provider');
    expect(migrateLegacyExecutionConfig(raw)).toBe(false);
  });

  it('uses raw axis presence when completing staged migration', () => {
    const newRunnerWithLegacyBuilder: Record<string, unknown> = {
      version: 1,
      execution: { runner: { provider: 'github-actions' } },
      agent: { default: 'claude', fallback: false }
    };
    expect(migrateLegacyExecutionConfig(newRunnerWithLegacyBuilder)).toBe(true);
    expect(newRunnerWithLegacyBuilder.execution).toMatchObject({
      runner: { provider: 'github-actions' },
      builder: { primary: { provider: 'claude' }, fallback: null }
    });

    const newBuilderWithLegacyRunner: Record<string, unknown> = {
      version: 1,
      execution: { builder: { primary: { provider: 'codex', model: null }, fallback: null } },
      scheduler: { provider: 'cron', jobs: {} }
    };
    expect(migrateLegacyExecutionConfig(newBuilderWithLegacyRunner)).toBe(true);
    expect(newBuilderWithLegacyRunner.execution).toMatchObject({
      runner: { provider: 'local' },
      builder: { primary: { provider: 'codex' }, fallback: null }
    });
  });
});
