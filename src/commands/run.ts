import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
import { runKaizen, type RunOptions } from '../orchestrator/run.js';
import { ConfigError } from '../utils/errors.js';
import { runSandboxSmoke } from './smoke.js';

export async function executeRun(options: RunOptions) {
  if (!options.job) return runKaizen(options);

  const resolved = await resolveProject(options.project, options.cwd);
  const config = await loadConfig(resolved.project.localPath);
  const job = config.scheduler.jobs[options.job];
  if (!job || !job.enabled || job.run.mode !== 'smoke') return runKaizen(options);
  if (options.dryRun || options.issue !== undefined || options.issueNumbers !== undefined || options.maxIssues !== undefined) {
    throw new ConfigError('Smoke scheduler jobs do not support issue selection, max issue overrides, or dry-run mode.');
  }

  return runSandboxSmoke({
    cwd: options.cwd,
    project: resolved.slug,
    agent: options.agent,
    json: options.json,
    assumeYes: true,
    schedulerJob: options.job,
    runCommand: options.runCommand
  });
}
