import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { requiredLabels } from './doctor.js';
import { configSchema, type KaizenConfig, type Registry, type RegistryProject } from '../config/schema.js';
import { loadRegistry, saveRegistry } from '../config/registry.js';
import { GitHubClient } from '../github/client.js';
import { enableScheduler } from '../scheduler/scheduler.js';
import type { CommandRunner } from '../utils/command.js';
import { projectStateDir, workspaceDir } from '../utils/paths.js';
import { repoFromRemote, slugFromRepo } from '../utils/slug.js';
import { GitClient } from '../workspace/git.js';
import { WorkspaceManager } from '../workspace/manager.js';

export interface FleetSyncOptions {
  cwd: string;
  root?: string;
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

export async function syncFleet(options: FleetSyncOptions): Promise<FleetSyncResult> {
  const root = await resolveFleetRoot(options.cwd, options.root, options.runCommand);
  const owner = options.owner ?? await ownerFromCwd(options.cwd, options.runCommand);
  const discovered = await discoverFleetProjects({ root, owner, repos: options.repos, runCommand: options.runCommand });
  const registry = await loadRegistry();
  const projects: FleetProjectResult[] = [];
  const seen = new Set<string>();

  for (const project of discovered) {
    seen.add(project.slug);
    projects.push(await syncFleetProject({ ...options, registry, project }));
  }

  const pruned: string[] = [];
  if (options.prune) {
    for (const slug of Object.keys(registry.projects)) {
      if (seen.has(slug)) continue;
      pruned.push(slug);
      if (!options.dryRun) delete registry.projects[slug];
    }
  }

  if (!options.dryRun) await saveRegistry(registry);
  return { root, owner, dryRun: options.dryRun, projects, pruned };
}

export function fleetHasFailures(result: FleetSyncResult): boolean {
  return result.projects.some((project) => Object.hasOwn(project, 'error') || project.verifyPassed === false);
}

async function syncFleetProject(options: FleetSyncOptions & {
  registry: Registry;
  project: DiscoveredFleetProject;
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
    const { config, migrated } = await loadFleetConfig(options.project.localPath, options.migrateConfig && !options.dryRun);
    result.configMigrated = migrated;

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
        await workspace.runSetup(config);
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

interface DiscoveredFleetProject {
  slug: string;
  repo: string;
  localPath: string;
  remoteUrl: string;
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

async function loadFleetConfig(repoDir: string, writeMigrated: boolean): Promise<{ config: KaizenConfig; migrated: boolean }> {
  const configPath = path.join(repoDir, '.kaizen', 'config.yml');
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed = parse(raw) as Record<string, unknown>;
  const migrated = migrateLegacySchedulerConfig(parsed);
  const config = configSchema.parse(parsed);
  if (migrated && writeMigrated) await fs.writeFile(configPath, stringify(parsed));
  return { config, migrated };
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
