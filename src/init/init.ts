import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { defaultConfigObject } from '../config/config.js';
import { configSchema } from '../config/schema.js';
import { upsertProject } from '../config/registry.js';
import { GitHubClient } from '../github/client.js';
import { hasSupervisorGitHubToken, type CommandRunner } from '../utils/command.js';
import { ConfigError } from '../utils/errors.js';
import { workspaceDir } from '../utils/paths.js';
import { repoFromRemote, slugFromRepo } from '../utils/slug.js';
import { GitClient } from '../workspace/git.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { detectCommands } from './detect.js';
import { bundledProfilesDir, applySafetyFloor, loadProfile, mergeOverlay } from './profile.js';
import { issueTemplateYaml } from './templates.js';

export interface InitOptions {
  cwd: string;
  agent?: 'claude' | 'codex';
  schedule: string;
  yes: boolean;
  profile?: string;
  profilesDir?: string;
  runCommand: CommandRunner;
}

export interface InitResult {
  slug: string;
  repo: string;
  configPath: string;
  profile?: string;
  safetyFloorCorrections: string[];
}

export async function initProject(options: InitOptions): Promise<InitResult> {
  const git = new GitClient(options.runCommand, options.cwd);
  const repoDir = await git.root();
  const remoteUrl = await git.remoteUrl('origin');
  const repo = repoFromRemote(remoteUrl);
  if (!repo) throw new ConfigError(`origin is not a GitHub remote: ${remoteUrl}`);

  const github = new GitHubClient(options.runCommand, repoDir);
  await github.authStatus();
  if (!hasSupervisorGitHubToken()) {
    throw new ConfigError('Set GH_TOKEN or GITHUB_TOKEN in the supervisor environment before initialization.');
  }

  const agent = chooseAgent(options.agent);
  const commands = await detectCommands(repoDir);
  const configPath = path.join(repoDir, '.kaizen', 'config.yml');
  const templatePath = path.join(repoDir, '.github', 'ISSUE_TEMPLATE', 'kaizen.yml');

  let config = defaultConfigObject({ agent, schedule: options.schedule, ...commands });
  let profileName: string | undefined;
  let corrections: string[] = [];
  if (options.profile) {
    const overlay = await loadProfile(options.profile, options.profilesDir ?? bundledProfilesDir());
    profileName = overlay.name;
    config = mergeOverlay(config, overlay.values) as Record<string, unknown>;
  }
  const floored = applySafetyFloor(config);
  config = floored.config;
  corrections = floored.corrections;

  // Validate before any write or external side effect. A profile can carry a
  // schema-invalid override, and without this init would create labels, a
  // workspace, and a registry entry, report success, and leave every later
  // command rejecting the config it just wrote.
  try {
    configSchema.parse(config);
  } catch (error) {
    const source = profileName ? `profile "${profileName}"` : 'generated configuration';
    throw new ConfigError(
      `The ${source} produces an invalid .kaizen/config.yml; nothing was written: ${String(error)}`
    );
  }

  await writeFileOnce(configPath, stringify(config), options.yes);
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

  return { slug, repo, configPath, profile: profileName, safetyFloorCorrections: corrections };
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
