import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KaizenConfig, RegistryProject } from '../config/schema.js';
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
    lines.push(`${cronTime(job)} ${commandLine(options.slug, job)} >> ${shQuote(path.join(projectStateDir(options.slug), `${job.name}.cron.log`))} 2>&1 # ${marker} ${job.name}`);
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
  name: 'nightly' | 'afternoon' | 'poll';
  trigger: 'scheduled' | 'afternoon' | 'watch';
  time?: string;
  intervalMinutes?: number;
}

function schedulerJobs(config: KaizenConfig, scheduleOverride?: string): SchedulerJob[] {
  const jobs: SchedulerJob[] = [];
  if (config.scheduler.nightly.enabled) {
    jobs.push({ name: 'nightly', trigger: 'scheduled', time: scheduleOverride ?? config.scheduler.nightly.time });
  }
  if (config.scheduler.afternoon.enabled) {
    jobs.push({ name: 'afternoon', trigger: 'afternoon', time: config.scheduler.afternoon.time });
  }
  if (config.scheduler.poll.enabled) {
    jobs.push({ name: 'poll', trigger: 'watch', intervalMinutes: config.scheduler.poll.intervalMinutes });
  }
  return jobs;
}

function legacyLaunchdPlistPath(slug: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.kaizen-loop.${slug}.plist`);
}

function launchdPlistPath(slug: string, jobName: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.kaizen-loop.${slug}.${jobName}.plist`);
}

function launchdPlist(slug: string, job: SchedulerJob): string {
  const stateDir = projectStateDir(slug);
  const schedule = job.time ? launchdCalendar(job.time) : launchdInterval(job.intervalMinutes ?? 5);
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
    <string>--trigger</string><string>${job.trigger}</string>
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

function cronTime(job: SchedulerJob): string {
  if (job.name === 'poll') return `*/${job.intervalMinutes ?? 5} * * * *`;
  const [hour, minute] = (job.time ?? '02:00').split(':');
  return `${Number(minute)} ${Number(hour)} * * *`;
}

function commandLine(slug: string, job: SchedulerJob): string {
  return `${shQuote(process.execPath)} ${shQuote(cliPath())} run --project ${shQuote(slug)} --scheduled --trigger ${shQuote(job.trigger)}`;
}

async function removeLaunchdPlists(slug: string, runCommand: CommandRunner): Promise<string[]> {
  const paths = [
    legacyLaunchdPlistPath(slug),
    launchdPlistPath(slug, 'nightly'),
    launchdPlistPath(slug, 'afternoon'),
    launchdPlistPath(slug, 'poll')
  ];
  for (const plistPath of paths) {
    await runCommand('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}`, plistPath], {
      rejectOnNonZero: false
    });
    await fs.rm(plistPath, { force: true });
  }
  return paths;
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

function launchdCalendar(time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  return `  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
}

function launchdInterval(intervalMinutes: number): string {
  return `  <key>StartInterval</key><integer>${intervalMinutes * 60}</integer>`;
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
