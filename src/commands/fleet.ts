import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { requiredLabels } from './doctor.js';
import { loadConfig } from '../config/config.js';
import { loadRegistry, registryTransaction, resolveProject } from '../config/registry.js';
import { configSchema, type KaizenConfig, type Registry, type RegistryProject } from '../config/schema.js';
import { GitHubClient } from '../github/client.js';
import { RunLock } from '../orchestrator/lock.js';
import { enableScheduler } from '../scheduler/scheduler.js';
import type { CommandRunner } from '../utils/command.js';
import { KaizenError } from '../utils/errors.js';
import { projectStateDir, workspaceDir } from '../utils/paths.js';
import { assertProjectSlug, repoFromRemote, slugFromRepo } from '../utils/slug.js';
import { GitClient } from '../workspace/git.js';
import { WorkspaceManager } from '../workspace/manager.js';

export interface FleetSyncOptions {
  cwd: string;
  root?: string;
  manifestPath?: string;
  owner?: string;
  repos?: string[];
  migrateConfig: boolean;
  ensureWorkspace: boolean;
  ensureLabels: boolean;
  syncScheduler: boolean;
  repairLocks: boolean;
  verify: boolean;
  prune: boolean;
  dryRun: boolean;
  runCommand: CommandRunner;
}

export interface FleetProjectResult {
  slug: string;
  repo: string;
  localPath: string;
  configMigrated: boolean;
  workspaceEnsured: boolean;
  labelsEnsured: boolean;
  schedulerSynced: boolean;
  lockRepaired: boolean;
  verified: boolean;
  setupResult?: { command: string; ok: boolean; output: string };
  verifyPassed?: boolean;
  verifyResults?: Array<{ command: string; ok: boolean; output: string }>;
  enabled: boolean;
  error?: string;
}

export interface FleetSyncResult {
  root: string;
  owner?: string;
  dryRun: boolean;
  projects: FleetProjectResult[];
  pruned: string[];
}

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

export async function syncFleet(options: FleetSyncOptions): Promise<FleetSyncResult> {
  if (options.manifestPath && (options.root || options.owner || options.repos?.length)) {
    throw new KaizenError('--manifest cannot be combined with --root, --owner, or --repo.');
  }
  if (options.prune && !options.manifestPath && !options.repos?.length) {
    throw new KaizenError('--prune requires --manifest or an explicit --repo expected set.');
  }
  const manifest = options.manifestPath ? await loadFleetManifest(options.manifestPath) : undefined;
  const root = manifest
    ? path.dirname(path.resolve(options.manifestPath!))
    : await resolveFleetRoot(options.cwd, options.root, options.runCommand);
  const owner = manifest?.owner ?? options.owner ?? await ownerFromCwd(options.cwd, options.runCommand);
  const discovered = manifest
    ? await discoverManifestProjects(manifest, options.manifestPath!, options.runCommand)
    : await discoverFleetProjects({ root, owner, repos: options.repos, runCommand: options.runCommand });
  assertExactRequestedSet(discovered, owner, options.repos);
  const prepared = await prepareFleetProjects(discovered);

  const execute = async (registry: Registry): Promise<{ registry?: Registry; value: FleetSyncResult }> => {
    const candidate = structuredClone(registry);
    const projectCount = Object.keys(registry.projects).length;
    if (options.prune && discovered.length === 0 && projectCount > 0) {
      throw new KaizenError(
        `Refusing to prune ${projectCount} registered project(s) because fleet discovery under ${root} found no projects.`
      );
    }
    const preflightFailures = prepared
      .filter((item) => item.error)
      .map((item) => fleetProjectError(item.project, item.error!));
    if (preflightFailures.length > 0) {
      return { value: { root, owner, dryRun: options.dryRun, projects: preflightFailures, pruned: [] } };
    }

    const projects: FleetProjectResult[] = [];
    const seen = new Set<string>();

    for (const project of discovered) {
      seen.add(project.slug);
      const item = prepared.find((entry) => entry.project.slug === project.slug)!;
      projects.push(await syncFleetProject({
        ...options,
        registry: candidate,
        project,
        config: item.config!,
        migrated: item.migrated!,
        migratedContent: item.migratedContent
      }));
    }

    const pruned: string[] = [];
    if (options.prune) {
      for (const slug of Object.keys(candidate.projects)) {
        if (seen.has(slug)) continue;
        pruned.push(slug);
        delete candidate.projects[slug];
      }
    }

    const value = { root, owner, dryRun: options.dryRun, projects, pruned };
    const failed = fleetHasFailures(value);
    return {
      registry: failed ? undefined : candidate,
      value: failed && !options.dryRun ? { ...value, pruned: [] } : value
    };
  };

  if (options.dryRun) return (await execute(await loadRegistry())).value;
  return registryTransaction(execute);
}

export function fleetHasFailures(result: FleetSyncResult): boolean {
  return result.projects.some((project) => Object.hasOwn(project, 'error') || project.verifyPassed === false);
}

export async function refreshFleet(options: {
  cwd: string;
  project?: string;
  sync?: boolean;
  runCommand: CommandRunner;
}): Promise<FleetRefreshResult> {
  const targets = await refreshTargets(options.project, options.cwd);
  const projects: FleetRefreshProject[] = [];
  for (const [slug, project] of targets) {
    projects.push(await refreshProject(slug, project, Boolean(options.sync), options.runCommand));
  }
  return {
    ok: projects.length > 0 && projects.every((project) => project.ok),
    sync: Boolean(options.sync),
    projects
  };
}

async function syncFleetProject(options: FleetSyncOptions & {
  registry: Registry;
  project: DiscoveredFleetProject;
  config: KaizenConfig;
  migrated: boolean;
  migratedContent?: string;
}): Promise<FleetProjectResult> {
  const result: FleetProjectResult = {
    slug: options.project.slug,
    repo: options.project.repo,
    localPath: options.project.localPath,
    configMigrated: false,
    workspaceEnsured: false,
    labelsEnsured: false,
    schedulerSynced: false,
    lockRepaired: false,
    verified: false,
    enabled: options.syncScheduler
  };

  try {
    const config = options.config;
    result.configMigrated = options.migrated;
    if (options.migrated && options.migrateConfig && !options.dryRun) {
      await fs.writeFile(path.join(options.project.localPath, '.kaizen', 'config.yml'), options.migratedContent!);
    }

    const registryProject = projectRegistryEntry(options.project, config, options.syncScheduler);
    if (!options.dryRun) options.registry.projects[options.project.slug] = registryProject;

    if (options.repairLocks) {
      result.lockRepaired = await repairStaleRunLock(options.project.slug, options.dryRun);
    }

    if (options.ensureWorkspace) {
      result.workspaceEnsured = true;
      if (!options.dryRun) {
        await new WorkspaceManager(options.runCommand, registryProject.workspacePath, options.project.remoteUrl).ensure();
      }
    }

    if (options.ensureLabels) {
      result.labelsEnsured = true;
      if (!options.dryRun) {
        await new GitHubClient(options.runCommand, options.project.localPath).createLabels(requiredLabels(config));
      }
    }

    if (options.syncScheduler) {
      result.schedulerSynced = true;
      if (!options.dryRun) {
        await enableScheduler({
          slug: options.project.slug,
          project: registryProject,
          config,
          runCommand: options.runCommand
        });
      }
    }

    if (options.verify) {
      result.verified = true;
      if (!options.dryRun) {
        const workspace = new WorkspaceManager(options.runCommand, registryProject.workspacePath, options.project.remoteUrl);
        await workspace.ensure();
        await workspace.sync(config.git.defaultBranch);
        const setupResult = await workspace.runSetup(config);
        if (setupResult) {
          result.setupResult = setupResult;
          if (!setupResult.ok) {
            result.verifyPassed = false;
            result.verifyResults = [];
            return result;
          }
        }
        const verifyResults = await workspace.runVerify(config);
        result.verifyResults = verifyResults;
        result.verifyPassed = verifyResults.every((item) => item.ok);
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
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

  try {
    config = await loadConfig(project.localPath);
    steps.push({ name: 'config', ok: true });
  } catch (error) {
    steps.push({ name: 'config', ok: false, message: String(error) });
  }

  if (config) {
    let lock: RunLock | undefined;
    try {
      lock = await RunLock.acquire(projectStateDir(slug));
      const remoteUrl = sync ? await resolveFleetRemote(runCommand, project) : githubRemote(project.repo);
      const workspace = new WorkspaceManager(runCommand, project.workspacePath, remoteUrl || githubRemote(project.repo));
      await refreshWorkspace(steps, slug, project, sync, workspace, config);
    } catch (error) {
      if (RunLock.isActiveError(error)) {
        steps.push({ name: 'workspace', ok: false, message: 'skipped because run is already active' });
        if (sync) steps.push({ name: 'sync', ok: false, message: 'skipped because run is already active' });
        steps.push({ name: 'setup', ok: false, message: 'skipped because run is already active' });
        steps.push({ name: 'verify', ok: false, message: 'skipped because run is already active' });
      } else {
        throw error;
      }
    } finally {
      await lock?.release();
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

async function resolveFleetRemote(runCommand: CommandRunner, project: RegistryProject): Promise<string> {
  try {
    return await new GitClient(runCommand, project.localPath).remoteUrl('origin');
  } catch {
    return githubRemote(project.repo);
  }
}

async function refreshWorkspace(
  steps: FleetRefreshStep[],
  slug: string,
  project: RegistryProject,
  sync: boolean,
  workspace: WorkspaceManager,
  config: KaizenConfig
): Promise<void> {
  let workspaceReady = false;
  if (sync) {
    const workspaceOk = await runStep(steps, 'workspace', async () => {
      assertSafeWorkspacePath(slug, project.workspacePath);
      await workspace.ensure();
    });
    const syncOk = workspaceOk
      ? await runStep(steps, 'sync', async () => {
        await workspace.sync(config.git.defaultBranch);
      })
      : false;
    workspaceReady = workspaceOk && syncOk;
  } else {
    workspaceReady = await runStep(steps, 'workspace', async () => {
      assertSafeWorkspacePath(slug, project.workspacePath);
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

interface DiscoveredFleetProject {
  slug: string;
  repo: string;
  localPath: string;
  remoteUrl: string;
}

const fleetManifestSchema = z.object({
  version: z.literal(1),
  owner: z.string().min(1),
  projects: z.array(z.object({
    repo: z.string().min(1),
    localPath: z.string().min(1)
  }).strict()).min(1)
}).strict();

type FleetManifest = z.infer<typeof fleetManifestSchema>;

interface PreparedFleetProject {
  project: DiscoveredFleetProject;
  config?: KaizenConfig;
  migrated?: boolean;
  migratedContent?: string;
  error?: string;
}

export async function loadFleetManifest(filePath: string): Promise<FleetManifest> {
  try {
    return fleetManifestSchema.parse(parse(await fs.readFile(path.resolve(filePath), 'utf8')));
  } catch (error) {
    throw new KaizenError(`Invalid fleet manifest at ${path.resolve(filePath)}: ${String(error)}`);
  }
}

async function discoverManifestProjects(
  manifest: FleetManifest,
  manifestPath: string,
  runCommand: CommandRunner
): Promise<DiscoveredFleetProject[]> {
  const base = path.dirname(path.resolve(manifestPath));
  const projects: DiscoveredFleetProject[] = [];
  for (const entry of manifest.projects) {
    const repo = entry.repo.includes('/') ? entry.repo : `${manifest.owner}/${entry.repo}`;
    if (!repo.startsWith(`${manifest.owner}/`)) {
      throw new KaizenError(`Fleet manifest repository ${repo} does not belong to owner ${manifest.owner}.`);
    }
    const localPath = path.resolve(base, entry.localPath);
    if (!await exists(path.join(localPath, '.git')) || !await exists(path.join(localPath, '.kaizen', 'config.yml'))) {
      throw new KaizenError(`Fleet manifest project ${repo} is missing a checkout or .kaizen/config.yml at ${localPath}.`);
    }
    const remoteUrl = await new GitClient(runCommand, localPath).remoteUrl('origin');
    const remoteRepo = repoFromRemote(remoteUrl);
    if (remoteRepo !== repo) {
      throw new KaizenError(`Fleet manifest expected ${repo} at ${localPath}, but origin is ${remoteRepo ?? remoteUrl}.`);
    }
    projects.push({ slug: slugFromRepo(repo), repo, localPath, remoteUrl });
  }
  const slugs = projects.map((project) => project.slug);
  if (new Set(slugs).size !== slugs.length) throw new KaizenError('Fleet manifest contains duplicate repositories.');
  return projects.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function prepareFleetProjects(projects: DiscoveredFleetProject[]): Promise<PreparedFleetProject[]> {
  return Promise.all(projects.map(async (project) => {
    try {
      const prepared = await loadFleetConfig(project.localPath);
      return { project, ...prepared };
    } catch (error) {
      return { project, error: error instanceof Error ? error.message : String(error) };
    }
  }));
}

function assertExactRequestedSet(projects: DiscoveredFleetProject[], owner: string | undefined, repos: string[] | undefined): void {
  if (!repos?.length) return;
  const requested = new Set(repos.map((repo) => repo.includes('/') ? repo : `${owner ?? ''}/${repo}`));
  const discovered = new Set(projects.map((project) => project.repo));
  const missing = [...requested].filter((repo) => !discovered.has(repo));
  if (missing.length > 0) {
    throw new KaizenError(`Refusing fleet apply because requested repositories were not discovered: ${missing.join(', ')}.`);
  }
}

function fleetProjectError(project: DiscoveredFleetProject, error: string): FleetProjectResult {
  return {
    slug: project.slug,
    repo: project.repo,
    localPath: project.localPath,
    configMigrated: false,
    workspaceEnsured: false,
    labelsEnsured: false,
    schedulerSynced: false,
    lockRepaired: false,
    verified: false,
    enabled: false,
    error
  };
}

async function discoverFleetProjects(options: {
  root: string;
  owner?: string;
  repos?: string[];
  runCommand: CommandRunner;
}): Promise<DiscoveredFleetProject[]> {
  const requested = new Set((options.repos ?? []).map((repo) => repo.includes('/') ? repo : `${options.owner ?? ''}/${repo}`));
  const entries = await fs.readdir(options.root, { withFileTypes: true });
  const candidates: DiscoveredFleetProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const localPath = path.join(options.root, entry.name);
    if (!await exists(path.join(localPath, '.git')) || !await exists(path.join(localPath, '.kaizen', 'config.yml'))) continue;

    const git = new GitClient(options.runCommand, localPath);
    const remoteUrl = await git.remoteUrl('origin');
    const repo = repoFromRemote(remoteUrl);
    if (!repo) continue;
    if (options.owner && !repo.startsWith(`${options.owner}/`)) continue;
    if (requested.size > 0 && !requested.has(repo)) continue;
    candidates.push({ slug: slugFromRepo(repo), repo, localPath, remoteUrl });
  }

  const projects = chooseCanonicalCheckouts(candidates);
  projects.sort((a, b) => a.slug.localeCompare(b.slug));
  return projects;
}

function chooseCanonicalCheckouts(candidates: DiscoveredFleetProject[]): DiscoveredFleetProject[] {
  const bySlug = new Map<string, DiscoveredFleetProject[]>();
  for (const candidate of candidates) {
    bySlug.set(candidate.slug, [...(bySlug.get(candidate.slug) ?? []), candidate]);
  }

  return [...bySlug.values()].map((items) => {
    const exact = items.find((item) => path.basename(item.localPath) === item.repo.split('/')[1]);
    return exact ?? items.sort((a, b) => a.localPath.localeCompare(b.localPath))[0];
  });
}

async function loadFleetConfig(repoDir: string): Promise<{ config: KaizenConfig; migrated: boolean; migratedContent?: string }> {
  const configPath = path.join(repoDir, '.kaizen', 'config.yml');
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed = parse(raw) as Record<string, unknown>;
  const migrated = migrateLegacySchedulerConfig(parsed);
  const config = configSchema.parse(parsed);
  return { config, migrated, migratedContent: migrated ? stringify(parsed) : undefined };
}

export function migrateLegacySchedulerConfig(config: Record<string, unknown>): boolean {
  const scheduler = record(config.scheduler);
  if (!scheduler || record(scheduler.jobs)) return false;
  const provider = typeof scheduler.provider === 'string' ? scheduler.provider : undefined;
  const nightly = legacyTimeJob(scheduler.nightly);
  const afternoon = legacyTimeJob(scheduler.afternoon);
  const poll = legacyPollJob(scheduler.poll);
  const maintenanceJobs = [nightly, afternoon].filter((job): job is LegacyTimeJob => Boolean(job));
  const maintenanceTimes = maintenanceJobs.filter((job) => job.enabled).map((job) => job.time);

  const jobs: Record<string, unknown> = {};
  if (maintenanceTimes.length === 1) {
    jobs.maintenance = {
      enabled: true,
      schedule: { type: 'daily', time: maintenanceTimes[0] },
      run: { mode: 'maintenance', lateStartGuard: true }
    };
  } else if (maintenanceTimes.length > 1) {
    jobs.maintenance = {
      enabled: true,
      schedule: { type: 'times', times: [...new Set(maintenanceTimes)] },
      run: { mode: 'maintenance', lateStartGuard: false }
    };
  } else if (maintenanceJobs.some((job) => !job.enabled)) {
    jobs.maintenance = {
      enabled: false,
      schedule: legacyMaintenanceSchedule(maintenanceJobs),
      run: { mode: 'maintenance', lateStartGuard: true }
    };
  }

  jobs['issue-watch'] = {
    enabled: Boolean(poll?.enabled),
    schedule: { type: 'interval', everyMinutes: poll?.intervalMinutes ?? 5 },
    run: { mode: 'watch', skipIfRunning: poll?.skipIfRunning ?? true }
  };

  if (!jobs.maintenance) {
    jobs.maintenance = {
      enabled: true,
      schedule: { type: 'daily', time: '02:00' },
      run: { mode: 'maintenance', lateStartGuard: true }
    };
  }

  config.scheduler = provider ? { provider, jobs } : { jobs };
  return true;
}

function projectRegistryEntry(project: DiscoveredFleetProject, config: KaizenConfig, enabled: boolean): RegistryProject {
  return {
    repo: project.repo,
    localPath: project.localPath,
    workspacePath: workspaceDir(project.slug),
    schedule: primarySchedule(config),
    enabled,
    createdAt: new Date().toISOString()
  };
}

function primarySchedule(config: KaizenConfig): string {
  const maintenance = config.scheduler.jobs.maintenance?.schedule;
  if (!maintenance) return '02:00';
  if (maintenance.type === 'daily') return maintenance.time;
  if (maintenance.type === 'times') return maintenance.times[0] ?? '02:00';
  if (maintenance.type === 'interval' && maintenance.anchorTime) return maintenance.anchorTime;
  return '02:00';
}

async function resolveFleetRoot(cwd: string, root: string | undefined, runCommand: CommandRunner): Promise<string> {
  if (root) return path.resolve(root);
  try {
    const repoRoot = await new GitClient(runCommand, cwd).root();
    return path.dirname(repoRoot);
  } catch {
    return path.resolve(cwd);
  }
}

async function ownerFromCwd(cwd: string, runCommand: CommandRunner): Promise<string | undefined> {
  try {
    const remoteUrl = await new GitClient(runCommand, cwd).remoteUrl('origin');
    return repoFromRemote(remoteUrl)?.split('/')[0];
  } catch {
    return undefined;
  }
}

async function repairStaleRunLock(slug: string, dryRun: boolean): Promise<boolean> {
  const lockPath = path.join(projectStateDir(slug), 'run.lock');
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const pid = (JSON.parse(raw) as { pid?: number }).pid;
    const stale = !pid || !isPidAlive(pid);
    if (!stale) return false;
    if (!dryRun) await fs.rm(lockPath, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (!dryRun) await fs.rm(lockPath, { force: true });
    return true;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface LegacyTimeJob {
  enabled: boolean;
  time: string;
}

function legacyTimeJob(value: unknown): LegacyTimeJob | undefined {
  const item = record(value);
  if (!item) return undefined;
  const time = typeof item.time === 'string' ? item.time : undefined;
  return { enabled: item.enabled !== false, time: time ?? '02:00' };
}

function legacyMaintenanceSchedule(jobs: LegacyTimeJob[]): { type: 'daily'; time: string } | { type: 'times'; times: string[] } {
  const times = [...new Set(jobs.map((job) => job.time))];
  if (times.length > 1) return { type: 'times', times };
  return { type: 'daily', time: times[0] ?? '02:00' };
}

function legacyPollJob(value: unknown): { enabled: boolean; intervalMinutes: number; skipIfRunning: boolean } | undefined {
  const item = record(value);
  if (!item) return undefined;
  const intervalMinutes = typeof item.intervalMinutes === 'number' ? item.intervalMinutes : 5;
  return {
    enabled: item.enabled === true,
    intervalMinutes,
    skipIfRunning: item.skipIfRunning !== false
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function githubRemote(repo: string): string {
  if (/^(?:[a-z]+:\/\/|git@)/i.test(repo)) return repo;
  return `https://github.com/${repo}.git`;
}

function assertSafeWorkspacePath(slug: string, projectWorkspacePath: string): void {
  assertProjectSlug(slug);
  if (path.resolve(projectWorkspacePath) !== path.resolve(workspaceDir(slug))) {
    throw new Error(`Refusing to refresh unsafe workspace path for ${slug}: ${projectWorkspacePath}`);
  }
}
