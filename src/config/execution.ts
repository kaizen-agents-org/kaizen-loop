import type { KaizenConfig } from './schema.js';

export type BuilderProvider = 'claude' | 'codex';
export type RunnerProvider =
  | 'local'
  | 'github-actions'
  | 'codex-automation'
  | 'claude-routine'
  | 'cursor'
  | 'external';

export interface NormalizedExecutionConfig {
  runner: { provider: RunnerProvider };
  builder: {
    primary: { provider: BuilderProvider; model: string | null };
    fallback: { provider: BuilderProvider; model: string | null } | null;
  };
  legacy: boolean;
}

export function executionConfig(config: KaizenConfig): NormalizedExecutionConfig {
  const canonicalRunner = config.execution?.runner;
  const canonicalBuilder = config.execution?.builder;
  if (canonicalRunner || canonicalBuilder) return {
    runner: canonicalRunner ?? { provider: legacyRunner(config.scheduler.provider) },
    builder: {
      primary: {
        provider: canonicalBuilder?.primary.provider ?? config.agent?.default ?? 'claude',
        model: canonicalBuilder?.primary.model ?? modelForLegacyPrimary(config) ?? null
      },
      fallback: canonicalBuilder
        ? canonicalBuilder.fallback
          ? {
              provider: canonicalBuilder.fallback.provider,
              model: canonicalBuilder.fallback.model ?? null
            }
          : null
        : legacyFallback(config)
    },
    legacy: Boolean(config.agent || config.scheduler.provider)
  };

  const primary = config.agent?.default ?? 'claude';
  const fallbackProvider: BuilderProvider = primary === 'claude' ? 'codex' : 'claude';
  return {
    runner: { provider: legacyRunner(config.scheduler.provider) },
    builder: {
      primary: { provider: primary, model: config.agent?.model[primary] ?? null },
      fallback: config.agent?.fallback === false
        ? null
        : { provider: fallbackProvider, model: config.agent?.model[fallbackProvider] ?? null }
    },
    legacy: Boolean(config.agent || config.scheduler.provider)
  };
}

export function migrateLegacyExecutionConfig(config: Record<string, unknown>): boolean {
  if (Object.hasOwn(config, 'execution') && !record(config.execution)) {
    throw new Error('execution must be an object');
  }
  const execution = record(config.execution);
  const agent = record(config.agent);
  const scheduler = record(config.scheduler) ?? {};
  const legacyProvider = typeof scheduler.provider === 'string' ? scheduler.provider : undefined;
  const hasBuilder = Boolean(execution && Object.hasOwn(execution, 'builder'));
  const hasRunner = Boolean(execution && Object.hasOwn(execution, 'runner'));

  if (hasBuilder && !record(execution?.builder)) {
    throw new Error('execution.builder must be an object');
  }
  if (hasRunner && !record(execution?.runner)) {
    throw new Error('execution.runner must be an object');
  }

  if (hasBuilder && agent) {
    throw new Error('execution.builder cannot be combined with legacy agent settings');
  }
  if (hasRunner && legacyProvider) {
    throw new Error('execution.runner cannot be combined with legacy scheduler.provider settings');
  }

  const primary = agent?.default === 'codex' ? 'codex' : 'claude';
  const fallbackProvider = primary === 'claude' ? 'codex' : 'claude';
  const models = record(agent?.model);
  const migratedExecution: Record<string, unknown> = execution ?? {};
  let migrated = false;
  if (!hasRunner) {
    migratedExecution.runner = { provider: legacyRunner(legacyProvider) };
    migrated = true;
  }
  if (!hasBuilder) {
    migratedExecution.builder = {
      primary: { provider: primary, model: nullableModel(models?.[primary]) },
      fallback: agent?.fallback === false
        ? null
        : { provider: fallbackProvider, model: nullableModel(models?.[fallbackProvider]) }
    };
    migrated = true;
  }
  config.execution = migratedExecution;
  if (agent) delete config.agent;
  if (legacyProvider) {
    delete scheduler.provider;
    config.scheduler = scheduler;
  }
  return migrated;
}

export function assertRunnerSupportedForLocalSync(config: KaizenConfig): void {
  const provider = executionConfig(config).runner.provider;
  if (provider !== 'local') {
    throw new Error(`scheduler sync does not support execution.runner.provider=${provider} yet`);
  }
}

function legacyRunner(provider: unknown): RunnerProvider {
  if (provider === 'launchd' || provider === 'cron' || provider === undefined) return 'local';
  if (
    provider === 'codex-automation' ||
    provider === 'claude-routine' ||
    provider === 'external'
  ) return provider;
  throw new Error(`Unsupported legacy scheduler.provider: ${String(provider)}`);
}

function nullableModel(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function modelForLegacyPrimary(config: KaizenConfig): string | null {
  const primary = config.agent?.default ?? 'claude';
  return config.agent?.model[primary] ?? null;
}

function legacyFallback(config: KaizenConfig): { provider: BuilderProvider; model: string | null } | null {
  if (config.agent?.fallback === false) return null;
  const primary = config.agent?.default ?? 'claude';
  const provider = primary === 'claude' ? 'codex' : 'claude';
  return { provider, model: config.agent?.model[provider] ?? null };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
