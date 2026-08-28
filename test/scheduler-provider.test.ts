import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { resolveLocalSchedulerProvider } from '../src/scheduler/provider.js';

describe('resolveLocalSchedulerProvider', () => {
  it('uses the platform default for the canonical local runner', () => {
    const config = configSchema.parse({ version: 1, execution: { runner: { provider: 'local' } } });
    expect(resolveLocalSchedulerProvider(config, 'darwin')).toBe('launchd');
    expect(resolveLocalSchedulerProvider(config, 'linux')).toBe('cron');
  });

  it('preserves a compatible legacy local scheduler selection', () => {
    const launchd = configSchema.parse({ version: 1, scheduler: { provider: 'launchd', jobs: {} } });
    const cron = configSchema.parse({ version: 1, scheduler: { provider: 'cron', jobs: {} } });
    expect(resolveLocalSchedulerProvider(launchd, 'darwin')).toBe('launchd');
    expect(resolveLocalSchedulerProvider(cron, 'linux')).toBe('cron');
  });

  it('rejects cross-platform legacy scheduler selections before mutation', () => {
    const launchd = configSchema.parse({ version: 1, scheduler: { provider: 'launchd', jobs: {} } });
    const cron = configSchema.parse({ version: 1, scheduler: { provider: 'cron', jobs: {} } });
    expect(() => resolveLocalSchedulerProvider(launchd, 'linux')).toThrow(
      'scheduler.provider=launchd is not supported on platform=linux'
    );
    expect(() => resolveLocalSchedulerProvider(cron, 'darwin')).toThrow(
      'scheduler.provider=cron is not supported on platform=darwin'
    );
  });

  it('rejects non-local runners instead of selecting a local adapter', () => {
    const config = configSchema.parse({ version: 1, execution: { runner: { provider: 'github-actions' } } });
    expect(() => resolveLocalSchedulerProvider(config, 'linux')).toThrow(
      'scheduler sync does not support execution.runner.provider=github-actions yet'
    );
  });
});
