import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KaizenConfig, RegistryProject, SchedulerJobConfig, SchedulerSchedule } from '../config/schema.js';
import type { CommandRunner } from '../utils/command.js';
import { projectStateDir } from '../utils/paths.js';

export async function enableScheduler(options: {
  slug: string;
  project: RegistryProject;
  config: KaizenConfig;
  schedule?: string;
  runCommand: CommandRunner;
  platform?: NodeJS.Platform;
}): Promise<{ type: 'launchd' | 'cron'; path?: string; paths?: string[]; jobs: SchedulerJob[] }> {
  const jobs = schedulerJobs(options.config, options.schedule);
  if ((options.platform ?? process.platform) === 'darwin') {
    await fs.mkdir(projectStateDir(options.slug), { recursive: true });
    await removeLaunchdPlists(options.slug, options.runCommand);
    const paths: string[] = [];
    for (const job of jobs) {
      const plistPath = launchdPlistPath(options.slug, job.name);
      paths.push(plistPath);
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, launchdPlist(options.slug, job));
      await options.runCommand('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? ''}`, plistPath]);
    }
    return { type: 'launchd', path: paths[0], paths, jobs };
  }

  await fs.mkdir(projectStateDir(options.slug), { recursive: true });
  const current = await options.runCommand('crontab', ['-l'], { rejectOnNonZero: false });
  const marker = cronMarker(options.slug);
  const lines = removeManagedCronLines(current.stdout, options.slug).filter((line) => line.trim());
  for (const job of jobs) {
    lines.push(`# ${marker} ${job.name}`);
    for (const cronTime of cronTimes(job.config.schedule)) {
      lines.push(`${cronTime} ${commandLine(options.slug, job)} >> ${shQuote(path.join(projectStateDir(options.slug), `${job.name}.cron.log`))} 2>&1 # ${marker} ${job.name}`);
    }
  }
  await options.runCommand('crontab', ['-'], { input: `${lines.join('\n')}\n` });
  return { type: 'cron', jobs };
}

export async function disableScheduler(options: {
  slug: string;
  runCommand: CommandRunner;
  terminateRunning?: boolean;
  platform?: NodeJS.Platform;
}): Promise<{ type: 'launchd' | 'cron'; path?: string; paths?: string[] }> {
  if (options.terminateRunning) await terminateLockPid(options.slug);

  if ((options.platform ?? process.platform) === 'darwin') {
    const paths = await removeLaunchdPlists(options.slug, options.runCommand);
    return { type: 'launchd', path: paths[0], paths };
  }

  const current = await options.runCommand('crontab', ['-l'], { rejectOnNonZero: false });
  const lines = removeManagedCronLines(current.stdout, options.slug);
  await options.runCommand('crontab', ['-'], { input: `${lines.filter(Boolean).join('\n')}\n` });
  return { type: 'cron' };
}

export interface SchedulerJob {
  name: string;
  config: SchedulerJobConfig;
}

export function schedulerJobs(config: KaizenConfig, scheduleOverride?: string): SchedulerJob[] {
  if (config.scheduler.jobs) {
    return Object.entries(config.scheduler.jobs)
      .filter(([, job]) => job.enabled)
      .map(([name, job]) => ({ name, config: job }));
  }

  const jobs: SchedulerJob[] = [];
  if (config.scheduler.nightly?.enabled || config.scheduler.afternoon?.enabled) {
    const times = [
      config.scheduler.nightly?.enabled ? (scheduleOverride ?? config.scheduler.nightly.time) : undefined,
      config.scheduler.afternoon?.enabled ? config.scheduler.afternoon.time : undefined
    ].filter((time): time is string => Boolean(time));
    jobs.push({
      name: 'maintenance',
      config: {
        enabled: true,
        schedule: times.length === 1 ? { type: 'daily', time: times[0] } : { type: 'times', times },
        run: { mode: 'maintenance', lateStartGuard: Boolean(config.scheduler.nightly?.enabled) }
      }
    });
  }
  if (config.scheduler.poll?.enabled) {
    jobs.push({
      name: 'issue-watch',
      config: {
        enabled: true,
        schedule: { type: 'interval', everyMinutes: config.scheduler.poll.intervalMinutes },
        run: { mode: 'watch', skipIfRunning: config.scheduler.poll.skipIfRunning }
      }
    });
  }
  return jobs;
}

export function schedulerJob(config: KaizenConfig, jobName: string): SchedulerJob | undefined {
  return schedulerJobs(config).find((job) => job.name === jobName);
}

function legacyLaunchdPlistPath(slug: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.kaizen-loop.${slug}.plist`);
}

function launchdPlistPath(slug: string, jobName: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.kaizen-loop.${slug}.${jobName}.plist`);
}

function launchdPlist(slug: string, job: SchedulerJob): string {
  const stateDir = projectStateDir(slug);
  const schedule = launchdSchedule(job.config.schedule);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kaizen-loop.${slug}.${job.name}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(cliPath())}</string>
    <string>run</string>
    <string>--project</string><string>${escapeXml(slug)}</string>
    <string>--scheduled</string>
    <string>--job</string><string>${escapeXml(job.name)}</string>
  </array>
${schedule}
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${escapeXml(process.env.PATH ?? '')}</string></dict>
  <key>StandardOutPath</key><string>${escapeXml(path.join(stateDir, `${job.name}.launchd.out.log`))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(stateDir, `${job.name}.launchd.err.log`))}</string>
</dict>
</plist>
`;
}

function cronMarker(slug: string): string {
  return `KAIZEN-LOOP ${slug} (managed by kaizen-loop; do not edit)`;
}

function commandLine(slug: string, job: SchedulerJob): string {
  return `${shQuote(process.execPath)} ${shQuote(cliPath())} run --project ${shQuote(slug)} --scheduled --job ${shQuote(job.name)}`;
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
  const times = scheduleTimes(schedule);
  if (times.length === 1) return launchdCalendar(times[0]);
  return `  <key>StartCalendarInterval</key>
  <array>
${times.map((time) => `    ${launchdCalendarDict(time)}`).join('\n')}
  </array>`;
}

function launchdCalendar(time: string): string {
  return `  <key>StartCalendarInterval</key>
  ${launchdCalendarDict(time)}`;
}

function launchdCalendarDict(time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  return `<dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
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

function cliPath(): string {
  return process.argv[1] ?? 'kaizen';
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function terminateLockPid(slug: string): Promise<void> {
  const lockPath = path.join(projectStateDir(slug), 'run.lock');
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const pid = (JSON.parse(raw) as { pid?: number }).pid;
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {
    // Best effort only; disable must still remove scheduler state.
  }
}
