export function executionConfig(config) {
    const canonicalRunner = config.execution?.runner;
    const canonicalBuilder = config.execution?.builder;
    if (canonicalRunner || canonicalBuilder)
        return {
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
    const fallbackProvider = primary === 'claude' ? 'codex' : 'claude';
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
export function migrateLegacyExecutionConfig(config) {
    const execution = record(config.execution);
    const agent = record(config.agent);
    const scheduler = record(config.scheduler) ?? {};
    const legacyProvider = typeof scheduler.provider === 'string' ? scheduler.provider : undefined;
    if (record(execution?.builder) && agent) {
        throw new Error('execution.builder cannot be combined with legacy agent settings');
    }
    if (record(execution?.runner) && legacyProvider) {
        throw new Error('execution.runner cannot be combined with legacy scheduler.provider settings');
    }
    const primary = agent?.default === 'codex' ? 'codex' : 'claude';
    const fallbackProvider = primary === 'claude' ? 'codex' : 'claude';
    const models = record(agent?.model);
    const migratedExecution = execution ?? {};
    let migrated = false;
    if (!record(migratedExecution.runner)) {
        migratedExecution.runner = { provider: legacyRunner(legacyProvider) };
        migrated = true;
    }
    if (!record(migratedExecution.builder)) {
        migratedExecution.builder = {
            primary: { provider: primary, model: nullableModel(models?.[primary]) },
            fallback: agent?.fallback === false
                ? null
                : { provider: fallbackProvider, model: nullableModel(models?.[fallbackProvider]) }
        };
        migrated = true;
    }
    config.execution = migratedExecution;
    if (agent)
        delete config.agent;
    if (legacyProvider) {
        delete scheduler.provider;
        config.scheduler = scheduler;
    }
    return migrated;
}
export function assertRunnerSupportedForLocalSync(config) {
    const provider = executionConfig(config).runner.provider;
    if (provider !== 'local') {
        throw new Error(`scheduler sync does not support execution.runner.provider=${provider} yet`);
    }
}
function legacyRunner(provider) {
    if (provider === 'launchd' || provider === 'cron' || provider === undefined)
        return 'local';
    if (provider === 'codex-automation' ||
        provider === 'claude-routine' ||
        provider === 'external')
        return provider;
    return 'local';
}
function nullableModel(value) {
    return typeof value === 'string' ? value : null;
}
function modelForLegacyPrimary(config) {
    const primary = config.agent?.default ?? 'claude';
    return config.agent?.model[primary] ?? null;
}
function legacyFallback(config) {
    if (config.agent?.fallback === false)
        return null;
    const primary = config.agent?.default ?? 'claude';
    const provider = primary === 'claude' ? 'codex' : 'claude';
    return { provider, model: config.agent?.model[provider] ?? null };
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
//# sourceMappingURL=execution.js.map