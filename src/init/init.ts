import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultConfigYaml } from '../config/config.js';
import { upsertProject } from '../config/registry.js';
import { GitHubClient } from '../github/client.js';
import type { CommandRunner } from '../utils/command.js';
import { ConfigError } from '../utils/errors.js';
import { workspaceDir } from '../utils/paths.js';
import { repoFromRemote, slugFromRepo } from '../utils/slug.js';
import { GitClient } from '../workspace/git.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { detectCommands } from './detect.js';
import { issueTemplateYaml } from './templates.js';

export interface InitOptions {
  cwd: string;
  agent?: 'claude' | 'codex';
  schedule: string;
  yes: boolean;
  runCommand: CommandRunner;
}

export async function initProject(options: InitOptions): Promise<{ slug: string; repo: string; configPath: string }> {
  const git = new GitClient(options.runCommand, options.cwd);
  const repoDir = await git.root();
  const remoteUrl = await git.remoteUrl('origin');
  const repo = repoFromRemote(remoteUrl);
  if (!repo) throw new ConfigError(`origin is not a GitHub remote: ${remoteUrl}`);

  const github = new GitHubClient(options.runCommand, repoDir);
  await github.authStatus();

  const agent = chooseAgent(options.agent);
  const commands = await detectCommands(repoDir);
  const configPath = path.join(repoDir, '.kaizen', 'config.yml');
  const templatePath = path.join(repoDir, '.github', 'ISSUE_TEMPLATE', 'kaizen.yml');

  await writeFileOnce(configPath, defaultConfigYaml({ agent, ...commands }), options.yes);
  await writeFileOnce(templatePath, issueTemplateYaml(), options.yes);
  await github.createLabels();

  const slug = slugFromRepo(repo);
  const workspacePath = workspaceDir(slug);
  const workspace = new WorkspaceManager(options.runCommand, workspacePath, remoteUrl);
  await workspace.ensure();

  await upsertProject(slug, {
    repo,
    localPath: repoDir,
    workspacePath,
    schedule: options.schedule,
    enabled: false,
    createdAt: new Date().toISOString()
  });

  return { slug, repo, configPath };
}

function chooseAgent(preferred: 'claude' | 'codex' | undefined): 'claude' | 'codex' {
  return preferred ?? 'claude';
}

async function writeFileOnce(filePath: string, content: string, overwrite: boolean): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, content, { flag: overwrite ? 'w' : 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ConfigError(`${filePath} already exists. Re-run with --yes to overwrite.`);
    }
    throw error;
  }
}
