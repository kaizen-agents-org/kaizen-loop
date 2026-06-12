import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RegistryProject } from '../config/schema.js';
import type { CommandRunner } from '../utils/command.js';
import { projectStateDir } from '../utils/paths.js';

export async function enableScheduler(options: {
  slug: string;
  project: RegistryProject;
  schedule: string;
  runCommand: CommandRunner;
  platform?: NodeJS.Platform;
}): Promise<{ type: 'launchd' | 'cron'; path?: string }> {
  if ((options.platform ?? process.platform) === 'darwin') {
    const plistPath = launchdPlistPath(options.slug);
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.mkdir(projectStateDir(options.slug), { recursive: true });
    await fs.writeFile(plistPath, launchdPlist(options.slug, options.schedule));
    await options.runCommand('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? ''}`, plistPath], {
      rejectOnNonZero: false
    });
    return { type: 'launchd', path: plistPath };
  }

  await fs.mkdir(projectStateDir(options.slug), { recursive: true });
  const current = await options.runCommand('crontab', ['-l'], { rejectOnNonZero: false });
  const marker = cronMarker(options.slug);
  const lines = current.stdout
    .split('\n')
    .filter((line) => line.trim() && !line.includes(marker));
  lines.push(`# ${marker}`);
  lines.push(`${cronTime(options.schedule)} ${process.execPath} ${cliPath()} run --project ${options.slug} --scheduled >> ${path.join(projectStateDir(options.slug), 'cron.log')} 2>&1`);
  await options.runCommand('crontab', ['-'], { input: `${lines.join('\n')}\n` });
  return { type: 'cron' };
}

export async function disableScheduler(options: {
  slug: string;
  runCommand: CommandRunner;
  terminateRunning?: boolean;
  platform?: NodeJS.Platform;
}): Promise<{ type: 'launchd' | 'cron'; path?: string }> {
  if (options.terminateRunning) await terminateLockPid(options.slug);

  if ((options.platform ?? process.platform) === 'darwin') {
    const plistPath = launchdPlistPath(options.slug);
    await options.runCommand('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}`, plistPath], {
      rejectOnNonZero: false
    });
    await fs.rm(plistPath, { force: true });
    return { type: 'launchd', path: plistPath };
  }

  const current = await options.runCommand('crontab', ['-l'], { rejectOnNonZero: false });
  const marker = cronMarker(options.slug);
  const lines = current.stdout
    .split('\n')
    .filter((line) => !line.includes(marker) && !line.includes(`run --project ${options.slug} --scheduled`));
  await options.runCommand('crontab', ['-'], { input: `${lines.filter(Boolean).join('\n')}\n` });
  return { type: 'cron' };
}

function launchdPlistPath(slug: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.kaizen-loop.${slug}.plist`);
}

function launchdPlist(slug: string, schedule: string): string {
  const [hour, minute] = schedule.split(':').map(Number);
  const stateDir = projectStateDir(slug);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kaizen-loop.${slug}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(cliPath())}</string>
    <string>run</string>
    <string>--project</string><string>${escapeXml(slug)}</string>
    <string>--scheduled</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${escapeXml(process.env.PATH ?? '')}</string></dict>
  <key>StandardOutPath</key><string>${escapeXml(path.join(stateDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(stateDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

function cronMarker(slug: string): string {
  return `KAIZEN-LOOP ${slug} (managed by kaizen-loop; do not edit)`;
}

function cronTime(schedule: string): string {
  const [hour, minute] = schedule.split(':');
  return `${Number(minute)} ${Number(hour)} * * *`;
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
