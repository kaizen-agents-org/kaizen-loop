import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KaizenConfig, RegistryProject, SchedulerJobConfig, SchedulerSchedule } from '../config/schema.js';
import {
  isTrustedExecutablePath,
  requireTrustedGitHubCliExecutable,
  type CommandRunner
} from '../utils/command.js';
import { ConfigError } from '../utils/errors.js';
import { getKaizenHome } from '../utils/paths.js';
import { resolveLocalSchedulerProvider, type LocalSchedulerProviderName } from './provider.js';

export interface SchedulerSyncResult {
  type: LocalSchedulerProviderName;
  path?: string;
  paths?: string[];
  jobs: SchedulerJob[];
  kaizenHome: string;
}

export interface SchedulerDisableResult {
  type: LocalSchedulerProviderName;
  path?: string;
  paths?: string[];
}

interface LocalSchedulerAdapter {
  readonly type: LocalSchedulerProviderName;
  enable(context: SchedulerEnableContext): Promise<SchedulerSyncResult>;
  disable(context: SchedulerDisableContext): Promise<SchedulerDisableResult>;
}

interface SchedulerEnableContext {
  slug: string;
  jobs: SchedulerJob[];
  runCommand: CommandRunner;
  kaizenHome: string;
  stateDir: string;
  scheduledLauncher?: string;
  schedulerPath?: string;
}

interface SchedulerDisableContext {
  slug: string;
  runCommand: CommandRunner;
  terminateRunning?: boolean;
}

export async function enableScheduler(options: {
  slug: string;
  project: RegistryProject;
  config: KaizenConfig;
  runCommand: CommandRunner;
  platform?: NodeJS.Platform;
  launcherTrust?: (launcher: string) => boolean;
}): Promise<SchedulerSyncResult> {
  const jobs = schedulerJobs(options.config);
  const platform = options.platform ?? process.platform;
  const adapter = localSchedulerAdapter(resolveLocalSchedulerProvider(options.config, platform));
  const kaizenHome = schedulerKaizenHome();
  const stateDir = path.join(kaizenHome, 'projects', options.slug);
  const scheduledLauncher = jobs.length === 0 ? undefined : requiredScheduledLauncher(options.launcherTrust);
  const schedulerPath = jobs.length === 0
    ? undefined
    : pathWithExecutable(requireTrustedGitHubCliExecutable(options.runCommand));
  if (scheduledLauncher && path.basename(scheduledLauncher) === 'run-scheduled.sh') {
    await installOperatorLauncher(kaizenHome);
  }
  return adapter.enable({
    slug: options.slug,
    jobs,
    runCommand: options.runCommand,
    kaizenHome,
    stateDir,
    scheduledLauncher,
    schedulerPath
  });
}

export async function disableScheduler(options: {
  slug: string;
  runCommand: CommandRunner;
  terminateRunning?: boolean;
  platform?: NodeJS.Platform;
}): Promise<SchedulerDisableResult> {
  const provider = (options.platform ?? process.platform) === 'darwin' ? 'launchd' : 'cron';
  return localSchedulerAdapter(provider).disable(options);
}

const launchdAdapter: LocalSchedulerAdapter = {
  type: 'launchd',
  async enable(context) {
    await fs.mkdir(context.stateDir, { recursive: true });
    await removeLaunchdPlists(context.slug, context.runCommand);
    const paths: string[] = [];
    for (const job of context.jobs) {
      const plistPath = launchdPlistPath(context.slug, job.name);
      paths.push(plistPath);
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, launchdPlist(context.slug, job, context.scheduledLauncher!, context.schedulerPath!, context.kaizenHome));
      await context.runCommand('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? ''}`, plistPath]);
    }
    return { type: this.type, path: paths[0], paths, jobs: context.jobs, kaizenHome: context.kaizenHome };
  },
  async disable(context) {
    if (context.terminateRunning) {
      await terminateLockPid(context.slug, await installedLaunchdKaizenHome(context.slug) ?? schedulerKaizenHome());
    }
    const paths = await removeLaunchdPlists(context.slug, context.runCommand);
    return { type: this.type, path: paths[0], paths };
  }
};

const cronAdapter: LocalSchedulerAdapter = {
  type: 'cron',
  async enable(context) {
    await fs.mkdir(context.stateDir, { recursive: true });
    const current = await context.runCommand('crontab', ['-l'], { rejectOnNonZero: false });
    const marker = cronMarker(context.slug);
    const lines = removeManagedCronLines(current.stdout, context.slug).filter((line) => line.trim());
    for (const job of context.jobs) {
      lines.push(`# ${marker} ${job.name}`);
      for (const cronTime of cronTimes(job.config.schedule)) {
        lines.push(`${cronTime} ${commandLine(context.slug, job, context.scheduledLauncher!, context.schedulerPath!, context.kaizenHome)} >> ${shQuote(path.join(context.stateDir, `${job.name}.cron.log`))} 2>&1 # ${marker} ${job.name}`);
      }
    }
    await context.runCommand('crontab', ['-'], { input: `${lines.join('\n')}\n` });
    return { type: this.type, jobs: context.jobs, kaizenHome: context.kaizenHome };
  },
  async disable(context) {
    const current = await context.runCommand('crontab', ['-l'], { rejectOnNonZero: false });
    if (context.terminateRunning) {
      await terminateLockPid(context.slug, installedCronKaizenHome(current.stdout, context.slug) ?? schedulerKaizenHome());
    }
    const lines = removeManagedCronLines(current.stdout, context.slug);
    await context.runCommand('crontab', ['-'], { input: `${lines.filter(Boolean).join('\n')}\n` });
    return { type: this.type };
  }
};

function localSchedulerAdapter(provider: LocalSchedulerProviderName): LocalSchedulerAdapter {
  return provider === 'launchd' ? launchdAdapter : cronAdapter;
}

export interface SchedulerJob {
  name: string;
  config: SchedulerJobConfig;
}

export function schedulerJobs(config: KaizenConfig): SchedulerJob[] {
  return Object.entries(config.scheduler.jobs)
    .filter(([, job]) => job.enabled)
    .map(([name, job]) => ({ name, config: job }));
}

export function schedulerJob(config: KaizenConfig, jobName: string): SchedulerJob | undefined {
  return schedulerJobs(config).find((job) => job.name === jobName);
}

export function schedulerKaizenHome(): string {
  return path.resolve(getKaizenHome());
}

export interface SchedulerLauncherStatus {
  scheduledLauncher: string | null;
  operatorLauncher: string | null;
  ready: boolean;
  error?: string;
}

export async function schedulerLauncherStatus(options: {
  required?: boolean;
  launcherTrust?: (launcher: string) => boolean;
} = {}): Promise<SchedulerLauncherStatus> {
  if (options.required === false) {
    return { scheduledLauncher: null, operatorLauncher: null, ready: true };
  }

  const inspected = inspectScheduledLauncher(options.launcherTrust);
  if (!inspected.ready) {
    return {
      scheduledLauncher: inspected.launcher,
      operatorLauncher: null,
      ready: false,
      error: 'The configured scheduled launcher is missing or is not an immutable operator-managed launcher.'
    };
  }

  if (path.basename(inspected.launcher!) !== 'run-scheduled.sh') {
    return { scheduledLauncher: inspected.launcher, operatorLauncher: null, ready: true };
  }

  const operatorLauncher = path.join(schedulerKaizenHome(), 'bin', 'kaizen');
  try {
    await fs.access(operatorLauncher, fsSync.constants.X_OK);
    return { scheduledLauncher: inspected.launcher, operatorLauncher, ready: true };
  } catch {
    return {
      scheduledLauncher: inspected.launcher,
      operatorLauncher,
      ready: false,
      error: `Kaizen operator launcher is missing or not executable: ${operatorLauncher}; run scheduler sync.`
    };
  }
}

function legacyLaunchdPlistPath(slug: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.kaizen-loop.${slug}.plist`);
}

function launchdPlistPath(slug: string, jobName: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.kaizen-loop.${slug}.${jobName}.plist`);
}

function launchdPlist(slug: string, job: SchedulerJob, launcher: string, schedulerPath: string, kaizenHome: string): string {
  const stateDir = path.join(kaizenHome, 'projects', slug);
  const schedule = launchdSchedule(job.config.schedule);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kaizen-loop.${slug}.${job.name}</string>
  <key>ProgramArguments</key>
  <array>
${path.extname(launcher) === '.sh' ? '    <string>/bin/sh</string>\n' : ''}
    <string>${escapeXml(launcher)}</string>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(slug)}</string>
    <string>${escapeXml(job.name)}</string>
  </array>
${schedule}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(schedulerPath)}</string>
    <key>KAIZEN_HOME</key><string>${escapeXml(kaizenHome)}</string>
    <key>KAIZEN_GITHUB_TOKEN_SOCKET</key><string></string>
    <key>KAIZEN_GITHUB_BROKER_CAPABILITY</key><string></string>
  </dict>
  <key>StandardOutPath</key><string>${escapeXml(path.join(stateDir, `${job.name}.launchd.out.log`))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(stateDir, `${job.name}.launchd.err.log`))}</string>
</dict>
</plist>
`;
}

function cronMarker(slug: string): string {
  return `KAIZEN-LOOP ${slug} (managed by kaizen-loop; do not edit)`;
}

function commandLine(slug: string, job: SchedulerJob, launcher: string, schedulerPath: string, kaizenHome: string): string {
  const interpreter = path.extname(launcher) === '.sh' ? '/bin/sh ' : '';
  const command = `PATH=${shQuote(schedulerPath)} KAIZEN_HOME=${shQuote(kaizenHome)} KAIZEN_GITHUB_TOKEN_SOCKET= KAIZEN_GITHUB_BROKER_CAPABILITY= ${interpreter}${shQuote(launcher)} ${shQuote(process.execPath)} ${shQuote(slug)} ${shQuote(job.name)}`;
  return command;
}

function pathWithExecutable(executable: string): string {
  const executableDir = path.dirname(executable);
  const inherited = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  return [...new Set([executableDir, ...inherited])].join(path.delimiter);
}

function requiredScheduledLauncher(trust = isTrustedExecutablePath): string {
  const inspected = inspectScheduledLauncher(trust);
  if (!inspected.ready) {
    throw new ConfigError(
      'Managed scheduling requires KAIZEN_CRON_SCHEDULED_LAUNCHER to name an absolute, immutable operator-managed run-scheduled.sh or kaizen-scheduled-launcher.'
    );
  }
  return inspected.launcher!;
}

function inspectScheduledLauncher(trust = isTrustedExecutablePath): { launcher: string | null; ready: boolean } {
  const launcher = process.env.KAIZEN_CRON_SCHEDULED_LAUNCHER;
  let resolvedLauncher: string | undefined;
  let trusted = false;
  if (
    launcher &&
    path.isAbsolute(launcher) &&
    ['run-scheduled.sh', 'kaizen-scheduled-launcher'].includes(path.basename(launcher))
  ) {
    try {
      resolvedLauncher = fsSync.realpathSync(launcher);
      trusted = resolvedLauncher === path.resolve(launcher) && trust(resolvedLauncher);
    } catch {
      trusted = false;
    }
  }
  return { launcher: resolvedLauncher ?? launcher ?? null, ready: trusted };
}

async function installOperatorLauncher(kaizenHome: string): Promise<void> {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'kaizen-runtime.sh');
  const destination = path.join(kaizenHome, 'bin', 'kaizen');
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, temporary);
    await fs.chmod(temporary, 0o755);
    await fs.rename(temporary, destination);
    await fs.access(destination, fsSync.constants.X_OK);
  } catch (error) {
    throw new ConfigError(
      `Cannot provision the Kaizen operator launcher at ${destination}; scheduler jobs were not changed. ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function removeLaunchdPlists(slug: string, runCommand: CommandRunner): Promise<string[]> {
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const paths = new Set<string>([
    legacyLaunchdPlistPath(slug),
    launchdPlistPath(slug, 'nightly'),
    launchdPlistPath(slug, 'afternoon'),
    launchdPlistPath(slug, 'poll')
  ]);
  try {
    const entries = await fs.readdir(launchAgentsDir);
    for (const entry of entries) {
      if (entry.startsWith(`com.kaizen-loop.${slug}.`) && entry.endsWith('.plist')) {
        paths.add(path.join(launchAgentsDir, entry));
      }
    }
  } catch {
    // LaunchAgents may not exist yet.
  }
  for (const plistPath of paths) {
    await runCommand('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}`, plistPath], {
      rejectOnNonZero: false
    });
    await fs.rm(plistPath, { force: true });
  }
  return [...paths];
}

function removeManagedCronLines(crontab: string, slug: string): string[] {
  const marker = cronMarker(slug);
  const lines: string[] = [];
  let skipNextCommand = false;

  for (const line of crontab.split('\n')) {
    const trimmed = line.trim();
    if (skipNextCommand && trimmed && !trimmed.startsWith('#')) {
      skipNextCommand = false;
      continue;
    }
    if (line.includes(marker) || legacyCronMarkerPattern(slug).test(line)) {
      skipNextCommand = trimmed.startsWith('#');
      continue;
    }
    lines.push(line);
  }

  return lines;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function legacyCronMarkerPattern(slug: string): RegExp {
  return new RegExp(`(^|\\s)#?\\s*KAIZEN-LOOP\\s+${escapeRegExp(slug)}(?:\\s|$)`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function launchdSchedule(schedule: SchedulerSchedule): string {
  if (schedule.type === 'interval' && schedule.everyMinutes !== undefined && schedule.anchorTime === undefined) {
    return launchdInterval(schedule.everyMinutes);
  }
  if (schedule.type === 'interval' && schedule.everyHours !== undefined && schedule.anchorTime === undefined) {
    return launchdInterval(schedule.everyHours * 60);
  }
  const calendars = scheduleCalendars(schedule);
  if (calendars.length === 1) return launchdCalendar(calendars[0]);
  return `  <key>StartCalendarInterval</key>
  <array>
${calendars.map((calendar) => `    ${launchdCalendarDict(calendar)}`).join('\n')}
  </array>`;
}

function launchdCalendar(calendar: LaunchdCalendar): string {
  return `  <key>StartCalendarInterval</key>
  ${launchdCalendarDict(calendar)}`;
}

interface LaunchdCalendar {
  time: string;
  day?: 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
}

function launchdCalendarDict(calendar: LaunchdCalendar): string {
  const [hour, minute] = calendar.time.split(':').map(Number);
  const weekday = calendar.day ? `<key>Weekday</key><integer>${launchdDay(calendar.day)}</integer>` : '';
  return `<dict>${weekday}<key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
}

function launchdInterval(intervalMinutes: number): string {
  return `  <key>StartInterval</key><integer>${intervalMinutes * 60}</integer>`;
}

function cronTimes(schedule: SchedulerSchedule): string[] {
  if (schedule.type === 'interval') {
    if (schedule.everyMinutes !== undefined) {
      if (schedule.everyMinutes > 59) throw new Error(`Unsupported cron interval: everyMinutes ${schedule.everyMinutes}`);
      return [`*/${schedule.everyMinutes} * * * *`];
    }
    if (schedule.everyHours !== undefined && schedule.anchorTime === undefined) {
      if (24 % schedule.everyHours !== 0) {
        throw new Error(`Unsupported cron hourly interval: everyHours ${schedule.everyHours}`);
      }
      return [`0 */${schedule.everyHours} * * *`];
    }
  }
  if (schedule.type === 'weekly') {
    const [hour, minute] = schedule.time.split(':').map(Number);
    return [`${minute} ${hour} * * ${schedule.days.map(cronDay).join(',')}`];
  }
  return scheduleTimes(schedule).map((time) => {
    const [hour, minute] = time.split(':').map(Number);
    return `${minute} ${hour} * * *`;
  });
}

function scheduleCalendars(schedule: SchedulerSchedule): LaunchdCalendar[] {
  if (schedule.type === 'weekly') {
    return schedule.days.map((day) => ({ time: schedule.time, day }));
  }
  return scheduleTimes(schedule).map((time) => ({ time }));
}

function scheduleTimes(schedule: SchedulerSchedule): string[] {
  if (schedule.type === 'daily') return [schedule.time];
  if (schedule.type === 'times') return schedule.times;
  if (schedule.type === 'interval' && schedule.everyHours !== undefined && schedule.anchorTime !== undefined) {
    return intervalTimes(schedule.anchorTime, schedule.everyHours);
  }
  if (schedule.type === 'rrule') throw new Error('RRULE schedules are not supported by launchd/cron providers yet.');
  throw new Error(`Unsupported calendar schedule: ${JSON.stringify(schedule)}`);
}

function intervalTimes(anchorTime: string, everyHours: number): string[] {
  if (24 % everyHours !== 0) throw new Error(`Unsupported anchored hourly interval: everyHours ${everyHours}`);
  const [anchorHour, anchorMinute] = anchorTime.split(':').map(Number);
  const times: string[] = [];
  for (let offset = 0; offset < 24; offset += everyHours) {
    const hour = (anchorHour + offset) % 24;
    times.push(`${String(hour).padStart(2, '0')}:${String(anchorMinute).padStart(2, '0')}`);
  }
  return [...new Set(times)].sort();
}

function cronDay(day: 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'): string {
  return { MO: '1', TU: '2', WE: '3', TH: '4', FR: '5', SA: '6', SU: '0' }[day];
}

function launchdDay(day: 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'): string {
  return { MO: '1', TU: '2', WE: '3', TH: '4', FR: '5', SA: '6', SU: '0' }[day];
}

function cliPath(): string {
  return process.argv[1] ?? 'kaizen';
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function installedLaunchdKaizenHome(slug: string): Promise<string | undefined> {
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  let entries: string[];
  try {
    entries = await fs.readdir(launchAgentsDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`com.kaizen-loop.${slug}.`) || !entry.endsWith('.plist')) continue;
    try {
      const plist = await fs.readFile(path.join(launchAgentsDir, entry), 'utf8');
      const match = plist.match(/<key>KAIZEN_HOME<\/key>\s*<string>([^<]*)<\/string>/);
      if (match) return unescapeXml(match[1]);
    } catch {
      // Keep looking for another installed job for this project.
    }
  }
  return undefined;
}

function installedCronKaizenHome(crontab: string, slug: string): string | undefined {
  const marker = cronMarker(slug);
  for (const line of crontab.split('\n')) {
    if (!line.includes(marker) || line.trimStart().startsWith('#')) continue;
    const prefix = ' KAIZEN_HOME=';
    const suffix = ' KAIZEN_GITHUB_TOKEN_SOCKET=';
    const start = line.indexOf(prefix);
    const end = line.indexOf(suffix, start + prefix.length);
    if (start < 0 || end < 0) continue;
    const quoted = line.slice(start + prefix.length, end);
    if (quoted.startsWith("'") && quoted.endsWith("'")) {
      return quoted.slice(1, -1).replace(/'\\''/g, "'");
    }
  }
  return undefined;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

async function terminateLockPid(slug: string, kaizenHome: string): Promise<void> {
  const lockPath = path.join(kaizenHome, 'projects', slug, 'run.lock');
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const pid = (JSON.parse(raw) as { pid?: number }).pid;
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {
    // Best effort only; disable must still remove scheduler state.
  }
}
