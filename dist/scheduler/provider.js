import { executionConfig } from '../config/execution.js';
import { ConfigError } from '../utils/errors.js';
export function resolveLocalSchedulerProvider(config, platform = process.platform) {
    const runner = executionConfig(config).runner.provider;
    if (runner !== 'local') {
        throw new ConfigError(`scheduler sync does not support execution.runner.provider=${runner} yet`);
    }
    const configured = config.scheduler.provider;
    if (configured === 'launchd' || configured === 'cron') {
        const supported = configured === 'launchd' ? platform === 'darwin' : platform !== 'darwin';
        if (!supported) {
            throw new ConfigError(`scheduler.provider=${configured} is not supported on platform=${platform}`);
        }
        return configured;
    }
    return platform === 'darwin' ? 'launchd' : 'cron';
}
//# sourceMappingURL=provider.js.map