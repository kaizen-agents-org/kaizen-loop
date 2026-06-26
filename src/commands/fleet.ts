import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config/config.js';
import { loadRegistry, resolveProject } from '../config/registry.js';
import type { KaizenConfig, RegistryProject } from '../config/schema.js';
import type { CommandRunner } from '../utils/command.js';
import { WorkspaceManager } from '../workspace/manager.js';

export interface FleetRefreshStep {
  name: string;
  ok: boolean;
  command?: string;
  message?: string;
  output?: string;
}

export interface FleetRefreshProject {
  slug: string;
  repo: string;
  localPath: string;
  workspacePath: string;
  defaultBranch?: string;
  ok: boolean;
  steps: FleetRefreshStep[];
}

export interface FleetRefreshResult {
  ok: boolean;
  sync: boolean;
  projects: FleetRefreshProject[];
}

export async function refreshFleet(options: {
  cwd: string;
  project?: string;
  sync?: boolean;
  runCommand: CommandRunner;
}): Promise<FleetRefreshResult> {
  const targets = await refreshTargets(options.project, options.cwd);
  const projects = [];
  for (const [slug, project] of targets) {
    projects.push(await refreshProject(slug, project, Boolean(options.sync), options.runCommand));
  }
  return {
    ok: projects.length > 0 && projects.every((project) => project.ok),
    sync: Boolean(options.sync),
    projects
  };
}

async function refreshTargets(projectSlug: string | undefined, cwd: string): Promise<Array<[string, RegistryProject]>> {
  if (projectSlug) {
    const resolved = await resolveProject(projectSlug, cwd);
    return [[resolved.slug, resolved.project]];
  }
  const registry = await loadRegistry();
  return Object.entries(registry.projects);
}

async function refreshProject(
  slug: string,
  project: RegistryProject,
  sync: boolean,
  runCommand: CommandRunner
): Promise<FleetRefreshProject> {
  const steps: FleetRefreshStep[] = [];
  let config: KaizenConfig | undefined;
  let workspace: WorkspaceManager | undefined;

  try {
    config = await loadConfig(project.localPath);
    workspace = new WorkspaceManager(runCommand, project.workspacePath, githubRemote(project.repo));
    steps.push({ name: 'config', ok: true });
  } catch (error) {
    steps.push({ name: 'config', ok: false, message: String(error) });
  }

  if (config && workspace) {
    let workspaceReady = false;
    if (sync) {
      const workspaceOk = await runStep(steps, 'workspace', async () => {
        await workspace!.ensure();
      });
      const syncOk = workspaceOk
        ? await runStep(steps, 'sync', async () => {
          await workspace!.sync(config!.git.defaultBranch);
        })
        : false;
      workspaceReady = workspaceOk && syncOk;
    } else {
      workspaceReady = await runStep(steps, 'workspace', async () => {
        await fs.access(path.join(project.workspacePath, '.git'));
      });
    }

    if (workspaceReady) {
      const setupOk = await runSetupStep(steps, workspace, config);
      if (setupOk) {
        await runVerifySteps(steps, workspace, config);
      } else {
        steps.push({ name: 'verify', ok: false, message: 'skipped because setup failed' });
      }
    } else {
      steps.push({ name: 'setup', ok: false, message: 'skipped because workspace is not ready' });
      steps.push({ name: 'verify', ok: false, message: 'skipped because workspace is not ready' });
    }
  }

  return {
    slug,
    repo: project.repo,
    localPath: project.localPath,
    workspacePath: project.workspacePath,
    defaultBranch: config?.git.defaultBranch,
    ok: steps.every((step) => step.ok),
    steps
  };
}

async function runSetupStep(steps: FleetRefreshStep[], workspace: WorkspaceManager, config: KaizenConfig): Promise<boolean> {
  if (!config.commands.setup) {
    steps.push({ name: 'setup', ok: true, message: 'not configured' });
    return true;
  }
  try {
    const result = await workspace.runSetup(config);
    const ok = Boolean(result?.ok);
    steps.push({
      name: 'setup',
      ok,
      command: config.commands.setup,
      output: result?.output
    });
    return ok;
  } catch (error) {
    steps.push({ name: 'setup', ok: false, command: config.commands.setup, message: String(error) });
    return false;
  }
}

async function runVerifySteps(steps: FleetRefreshStep[], workspace: WorkspaceManager, config: KaizenConfig): Promise<void> {
  if (config.commands.verify.length === 0) {
    steps.push({ name: 'verify', ok: true, message: 'not configured' });
    return;
  }
  try {
    const results = await workspace.runVerify(config);
    for (const result of results) {
      steps.push({
        name: 'verify',
        ok: result.ok,
        command: result.command,
        output: result.output
      });
    }
  } catch (error) {
    steps.push({ name: 'verify', ok: false, message: String(error) });
  }
}

async function runStep(steps: FleetRefreshStep[], name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    steps.push({ name, ok: true });
    return true;
  } catch (error) {
    steps.push({ name, ok: false, message: String(error) });
    return false;
  }
}

function githubRemote(repo: string): string {
  if (/^(?:[a-z]+:\/\/|git@)/i.test(repo)) return repo;
  return `https://github.com/${repo}.git`;
}
