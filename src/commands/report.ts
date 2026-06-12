import { resolveProject } from '../config/registry.js';
import { GitHubClient } from '../github/client.js';
import type { CommandRunner } from '../utils/command.js';

export async function reportIssue(options: {
  cwd: string;
  project?: string;
  title: string;
  body: string;
  priority?: 'P0' | 'P1' | 'P2';
  direct?: boolean;
  prOnly?: boolean;
  agent?: 'claude' | 'codex';
  extraLabels: string[];
  runCommand: CommandRunner;
}) {
  const resolved = await resolveProject(options.project, options.cwd);
  const github = new GitHubClient(options.runCommand, resolved.project.localPath);
  const labels = ['kaizen', `kaizen:${options.priority ?? 'P2'}`, ...options.extraLabels];
  if (options.direct) labels.push('kaizen:direct');
  if (options.prOnly) labels.push('kaizen:pr-only');
  if (options.agent) labels.push(`kaizen:agent:${options.agent}`);
  return github.createIssue({
    title: options.title,
    body: options.body,
    labels
  });
}
