import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isTrustedExecutablePath, requireTrustedGitHubCliExecutable } from '../utils/command.js';
import { ConfigError } from '../utils/errors.js';
import { projectStateDir } from '../utils/paths.js';
export async function enableScheduler(options) {
    const jobs = schedulerJobs(options.config);
    const platform = options.platform ?? process.platform;
    const scheduledLauncher = jobs.length === 0 ? undefined : requiredScheduledLauncher(options.launcherTrust);
    const schedulerPath = jobs.length === 0
        ? undefined
        : pathWithExecutable(requireTrustedGitHubCliExecutable(options.runCommand));
    if (platform === 'darwin') {
        await fs.mkdir(projectStateDir(options.slug), { recursive: true });
        await removeLaunchdPlists(options.slug, options.runCommand);
        const paths = [];
        for (const job of jobs) {
            const plistPath = launchdPlistPath(options.slug, job.name);
            paths.push(plistPath);
            await fs.mkdir(path.dirname(plistPath), { recursive: true });
            await fs.writeFile(plistPath, launchdPlist(options.slug, job, scheduledLauncher, schedulerPath));
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
            lines.push(`${cronTime} ${commandLine(options.slug, job, scheduledLauncher, schedulerPath)} >> ${shQuote(path.join(projectStateDir(options.slug), `${job.name}.cron.log`))} 2>&1 # ${marker} ${job.name}`);
        }
    }
    await options.runCommand('crontab', ['-'], { input: `${lines.join('\n')}\n` });
    return { type: 'cron', jobs };
}
export async function disableScheduler(options) {
    if (options.terminateRunning)
        await terminateLockPid(options.slug);
    if ((options.platform ?? process.platform) === 'darwin') {
        const paths = await removeLaunchdPlists(options.slug, options.runCommand);
        return { type: 'launchd', path: paths[0], paths };
    }
    const current = await options.runCommand('crontab', ['-l'], { rejectOnNonZero: false });
    const lines = removeManagedCronLines(current.stdout, options.slug);
    await options.runCommand('crontab', ['-'], { input: `${lines.filter(Boolean).join('\n')}\n` });
    return { type: 'cron' };
}
export function schedulerJobs(config) {
    return Object.entries(config.scheduler.jobs)
        .filter(([, job]) => job.enabled)
        .map(([name, job]) => ({ name, config: job }));
}
export function schedulerJob(config, jobName) {
    return schedulerJobs(config).find((job) => job.name === jobName);
}
function legacyLaunchdPlistPath(slug) {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.kaizen-loop.${slug}.plist`);
}
function launchdPlistPath(slug, jobName) {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.kaizen-loop.${slug}.${jobName}.plist`);
}
function launchdPlist(slug, job, launcher, schedulerPath) {
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
    <key>KAIZEN_GITHUB_TOKEN_SOCKET</key><string></string>
    <key>KAIZEN_GITHUB_BROKER_CAPABILITY</key><string></string>
  </dict>
  <key>StandardOutPath</key><string>${escapeXml(path.join(stateDir, `${job.name}.launchd.out.log`))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(stateDir, `${job.name}.launchd.err.log`))}</string>
</dict>
</plist>
`;
}
function cronMarker(slug) {
    return `KAIZEN-LOOP ${slug} (managed by kaizen-loop; do not edit)`;
}
function commandLine(slug, job, launcher, schedulerPath) {
    const interpreter = path.extname(launcher) === '.sh' ? '/bin/sh ' : '';
    const command = `PATH=${shQuote(schedulerPath)} KAIZEN_GITHUB_TOKEN_SOCKET= KAIZEN_GITHUB_BROKER_CAPABILITY= ${interpreter}${shQuote(launcher)} ${shQuote(process.execPath)} ${shQuote(slug)} ${shQuote(job.name)}`;
    return command;
}
function pathWithExecutable(executable) {
    const executableDir = path.dirname(executable);
    const inherited = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((entry) => entry && entry !== executableDir);
    return [executableDir, ...inherited].join(path.delimiter);
}
function requiredScheduledLauncher(trust = isTrustedExecutablePath) {
    const launcher = process.env.KAIZEN_CRON_SCHEDULED_LAUNCHER;
    let resolvedLauncher;
    let trusted = false;
    if (launcher &&
        path.isAbsolute(launcher) &&
        ['run-scheduled.sh', 'kaizen-scheduled-launcher'].includes(path.basename(launcher))) {
        try {
            resolvedLauncher = fsSync.realpathSync(launcher);
            trusted = resolvedLauncher === path.resolve(launcher) && trust(resolvedLauncher);
        }
        catch {
            trusted = false;
        }
    }
    if (!trusted) {
        throw new ConfigError('Managed scheduling requires KAIZEN_CRON_SCHEDULED_LAUNCHER to name an absolute, immutable operator-managed run-scheduled.sh or kaizen-scheduled-launcher.');
    }
    return resolvedLauncher;
}
async function removeLaunchdPlists(slug, runCommand) {
    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const paths = new Set([
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
    }
    catch {
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
function removeManagedCronLines(crontab, slug) {
    const marker = cronMarker(slug);
    const lines = [];
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
function shQuote(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
function legacyCronMarkerPattern(slug) {
    return new RegExp(`(^|\\s)#?\\s*KAIZEN-LOOP\\s+${escapeRegExp(slug)}(?:\\s|$)`);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function launchdSchedule(schedule) {
    if (schedule.type === 'interval' && schedule.everyMinutes !== undefined && schedule.anchorTime === undefined) {
        return launchdInterval(schedule.everyMinutes);
    }
    if (schedule.type === 'interval' && schedule.everyHours !== undefined && schedule.anchorTime === undefined) {
        return launchdInterval(schedule.everyHours * 60);
    }
    const calendars = scheduleCalendars(schedule);
    if (calendars.length === 1)
        return launchdCalendar(calendars[0]);
    return `  <key>StartCalendarInterval</key>
  <array>
${calendars.map((calendar) => `    ${launchdCalendarDict(calendar)}`).join('\n')}
  </array>`;
}
function launchdCalendar(calendar) {
    return `  <key>StartCalendarInterval</key>
  ${launchdCalendarDict(calendar)}`;
}
function launchdCalendarDict(calendar) {
    const [hour, minute] = calendar.time.split(':').map(Number);
    const weekday = calendar.day ? `<key>Weekday</key><integer>${launchdDay(calendar.day)}</integer>` : '';
    return `<dict>${weekday}<key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
}
function launchdInterval(intervalMinutes) {
    return `  <key>StartInterval</key><integer>${intervalMinutes * 60}</integer>`;
}
function cronTimes(schedule) {
    if (schedule.type === 'interval') {
        if (schedule.everyMinutes !== undefined) {
            if (schedule.everyMinutes > 59)
                throw new Error(`Unsupported cron interval: everyMinutes ${schedule.everyMinutes}`);
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
function scheduleCalendars(schedule) {
    if (schedule.type === 'weekly') {
        return schedule.days.map((day) => ({ time: schedule.time, day }));
    }
    return scheduleTimes(schedule).map((time) => ({ time }));
}
function scheduleTimes(schedule) {
    if (schedule.type === 'daily')
        return [schedule.time];
    if (schedule.type === 'times')
        return schedule.times;
    if (schedule.type === 'interval' && schedule.everyHours !== undefined && schedule.anchorTime !== undefined) {
        return intervalTimes(schedule.anchorTime, schedule.everyHours);
    }
    if (schedule.type === 'rrule')
        throw new Error('RRULE schedules are not supported by launchd/cron providers yet.');
    throw new Error(`Unsupported calendar schedule: ${JSON.stringify(schedule)}`);
}
function intervalTimes(anchorTime, everyHours) {
    if (24 % everyHours !== 0)
        throw new Error(`Unsupported anchored hourly interval: everyHours ${everyHours}`);
    const [anchorHour, anchorMinute] = anchorTime.split(':').map(Number);
    const times = [];
    for (let offset = 0; offset < 24; offset += everyHours) {
        const hour = (anchorHour + offset) % 24;
        times.push(`${String(hour).padStart(2, '0')}:${String(anchorMinute).padStart(2, '0')}`);
    }
    return [...new Set(times)].sort();
}
function cronDay(day) {
    return { MO: '1', TU: '2', WE: '3', TH: '4', FR: '5', SA: '6', SU: '0' }[day];
}
function launchdDay(day) {
    return { MO: '1', TU: '2', WE: '3', TH: '4', FR: '5', SA: '6', SU: '0' }[day];
}
function cliPath() {
    return process.argv[1] ?? 'kaizen';
}
function escapeXml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function terminateLockPid(slug) {
    const lockPath = path.join(projectStateDir(slug), 'run.lock');
    try {
        const raw = await fs.readFile(lockPath, 'utf8');
        const pid = JSON.parse(raw).pid;
        if (pid)
            process.kill(pid, 'SIGTERM');
    }
    catch {
        // Best effort only; disable must still remove scheduler state.
    }
}
//# sourceMappingURL=scheduler.js.map