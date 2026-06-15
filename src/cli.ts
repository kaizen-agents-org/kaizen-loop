#!/usr/bin/env node
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { initProject } from './init/init.js';
import { type DirectCommitConfirmation, runKaizen } from './orchestrator/run.js';
import { loadRegistry, resolveProject, saveRegistry } from './config/registry.js';
import { loadConfig } from './config/config.js';
import { runCommand } from './utils/command.js';
import { KaizenError } from './utils/errors.js';
import { reportIssue, reportIssueNow } from './commands/report.js';
import { listQueuedIssues, queueIssues, unqueueIssues } from './commands/queue.js';
import { statusProject } from './commands/status.js';
import { readLogs } from './commands/logs.js';
import { doctorProject } from './commands/doctor.js';
import { disableScheduler, enableScheduler } from './scheduler/scheduler.js';

const program = new Command();

program
  .name('kaizen')
  .description('Run a local AI-powered Kaizen Loop over GitHub issues.')
  .version('0.1.0')
  .option('--project <slug>', 'target project slug')
  .option('--json', 'print machine-readable output');

program
  .command('init')
  .description('initialize Kaizen Loop in the current GitHub repository')
  .option('--agent <agent>', 'agent to use: claude or codex')
  .option('--schedule <HH:MM>', 'scheduled run time', '02:00')
  .option('--yes', 'overwrite generated files when they already exist', false)
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ json?: boolean }>();
    const result = await initProject({
      cwd: process.cwd(),
      agent: parseAgent(options.agent),
      schedule: parseSchedule(options.schedule),
      yes: Boolean(options.yes),
      runCommand
    });
    print({
      message: 'Kaizen Loop initialized.',
      ...result
    }, Boolean(options.json ?? globals.json));
  });

program
  .command('run')
  .description('run the maintenance pipeline once')
  .option('--project <slug>', 'target project slug')
  .option('--json', 'print machine-readable output')
  .option('--scheduled', 'scheduled unattended mode', false)
  .option('--trigger <trigger>', 'trigger override: manual, scheduled, instant, or watch')
  .option('--issue <number>', 'process only one issue')
  .option('--dry-run', 'select issues without modifying workspaces or GitHub', false)
  .option('--max-issues <number>', 'override max issues for this run')
  .option('--agent <agent>', 'agent override: claude or codex')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const json = Boolean(options.json ?? globals.json);
    const result = await runKaizen({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      scheduled: Boolean(options.scheduled),
      trigger: parseTrigger(options.trigger),
      issue: options.issue ? Number(options.issue) : undefined,
      dryRun: Boolean(options.dryRun),
      maxIssues: options.maxIssues ? Number(options.maxIssues) : undefined,
      agent: parseAgent(options.agent),
      json,
      runCommand
    });
    print(result, json);
  });

program
  .command('list')
  .description('list registered projects')
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ json?: boolean }>();
    const registry = await loadRegistry();
    print(registry, Boolean(options.json ?? globals.json));
  });

program
  .command('report')
  .description('create a Kaizen issue')
  .argument('<title>', 'issue title')
  .option('--project <slug>', 'target project slug')
  .option('--body <body>', 'issue body', '')
  .option('--body-file <path>', 'read issue body from file or stdin with -')
  .option('--priority <P0|P1|P2>', 'priority label', 'P2')
  .option('--direct', 'add kaizen:direct label', false)
  .option('--pr-only', 'add kaizen:pr-only label', false)
  .option('--agent <agent>', 'agent label: claude or codex')
  .option('--queue', 'mark the issue as approved for queued Kaizen execution')
  .option('--no-queue', 'create the issue without the queued execution label')
  .option('--label <label...>', 'extra label')
  .option('--now', 'process the created issue immediately', false)
  .option('--yes', 'skip direct commit confirmation when used with --now', false)
  .option('--json', 'print machine-readable output')
  .action(async (title, options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const json = Boolean(options.json ?? globals.json);
    const assumeYes = Boolean(options.yes);
    if (assumeYes && !options.now) {
      throw new KaizenError('--yes can only be used with --now', 2);
    }
    const reportOptions = {
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      title,
      body: await resolveBody(options.body, options.bodyFile),
      priority: parsePriority(options.priority),
      direct: Boolean(options.direct),
      prOnly: Boolean(options.prOnly),
      agent: parseAgent(options.agent),
      queue: queueForReport(options.queue, Boolean(options.now)),
      extraLabels: options.label ?? [],
      runCommand
    };
    const result = options.now
      ? await reportIssueNow({
        ...reportOptions,
        json,
        assumeYes,
        confirmDirectCommit: !assumeYes && !json && process.stdin.isTTY && process.stdout.isTTY
          ? promptDirectCommit
          : undefined
      })
      : await reportIssue(reportOptions);
    print(result, json);
  });

program
  .command('fix')
  .description('process one existing issue immediately')
  .argument('<issue>', 'issue number')
  .option('--project <slug>', 'target project slug')
  .option('--agent <agent>', 'agent override: claude or codex')
  .option('--yes', 'skip direct commit confirmation', false)
  .option('--json', 'print machine-readable output')
  .action(async (issue, options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const json = Boolean(options.json ?? globals.json);
    const assumeYes = Boolean(options.yes);
    const result = await runKaizen({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      scheduled: false,
      trigger: 'instant',
      issue: Number(issue),
      dryRun: false,
      maxIssues: 1,
      agent: parseAgent(options.agent),
      json,
      assumeYes,
      confirmDirectCommit: !assumeYes && !json && process.stdin.isTTY && process.stdout.isTTY
        ? promptDirectCommit
        : undefined,
      runCommand
    });
    print(result, json);
  });

program
  .command('queue')
  .description('mark existing Kaizen issues as approved for queued execution')
  .argument('[issues...]', 'issue numbers')
  .option('--project <slug>', 'target project slug')
  .option('--list', 'list queued issues instead of changing labels', false)
  .option('--json', 'print machine-readable output')
  .action(async (issues, options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const json = Boolean(options.json ?? globals.json);
    if (options.list) {
      print(await listQueuedIssues({
        cwd: process.cwd(),
        project: options.project ?? globals.project,
        runCommand
      }), json);
      return;
    }
    const result = await queueIssues({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      issues: parseIssueArguments(issues),
      runCommand
    });
    print(result, json);
  });

program
  .command('unqueue')
  .description('remove queued execution approval from existing Kaizen issues')
  .argument('<issues...>', 'issue numbers')
  .option('--project <slug>', 'target project slug')
  .option('--json', 'print machine-readable output')
  .action(async (issues, options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const result = await unqueueIssues({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      issues: parseIssueArguments(issues),
      runCommand
    });
    print(result, Boolean(options.json ?? globals.json));
  });

program
  .command('status')
  .description('show loop status')
  .option('--project <slug>', 'target project slug')
  .option('--metrics', 'include aggregate metrics', false)
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const result = await statusProject({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      metrics: Boolean(options.metrics),
      runCommand
    });
    print(result, Boolean(options.json ?? globals.json));
  });

program
  .command('enable')
  .description('enable scheduler for a project')
  .option('--project <slug>', 'target project slug')
  .option('--schedule <HH:MM>', 'schedule time')
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const resolved = await resolveProject(options.project ?? globals.project, process.cwd());
    const registry = await loadRegistry();
    const project = registry.projects[resolved.slug];
    const config = await loadConfig(project.localPath);
    const schedule = parseSchedule(options.schedule ?? config.scheduler.nightly.time);
    const scheduler = await enableScheduler({ slug: resolved.slug, project, config, schedule, runCommand });
    project.enabled = true;
    project.schedule = schedule;
    await saveRegistry(registry);
    print({ slug: resolved.slug, enabled: true, scheduler }, Boolean(options.json ?? globals.json));
  });

program
  .command('disable')
  .description('disable scheduler for a project')
  .option('--project <slug>', 'target project slug')
  .option('--all', 'disable all registered projects', false)
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const registry = await loadRegistry();
    const targets = options.all
      ? Object.entries(registry.projects)
      : [[(await resolveProject(options.project ?? globals.project, process.cwd())).slug, (await resolveProject(options.project ?? globals.project, process.cwd())).project] as const];
    const results = [];
    for (const [slug, project] of targets) {
      const scheduler = await disableScheduler({ slug, runCommand, terminateRunning: true });
      project.enabled = false;
      results.push({ slug, enabled: false, scheduler });
    }
    await saveRegistry(registry);
    print(results, Boolean(options.json ?? globals.json));
  });

program
  .command('logs')
  .description('show latest run logs')
  .option('--project <slug>', 'target project slug')
  .option('--run <timestamp>', 'run timestamp')
  .option('--issue <number>', 'issue number')
  .action(async (options) => {
    const globals = program.opts<{ project?: string }>();
    console.log(await readLogs({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      run: options.run,
      issue: options.issue ? Number(options.issue) : undefined
    }));
  });

program
  .command('doctor')
  .description('diagnose local Kaizen setup')
  .option('--project <slug>', 'target project slug')
  .option('--repair', 'attempt repairs where possible', false)
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const result = await doctorProject({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      repair: Boolean(options.repair),
      runCommand
    });
    print(result, Boolean(options.json ?? globals.json));
  });

program
  .command('watch')
  .description('not implemented until Phase 4')
  .action(() => {
    throw new KaizenError('kaizen watch is planned for Phase 4.', 2);
  });

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (typeof error === 'object' && error && 'code' in error && error.code === 'commander.helpDisplayed') {
    process.exit(0);
  }
  const exitCode = error instanceof KaizenError ? error.exitCode : 1;
  const message = error instanceof Error ? error.message : String(error);
  if (!/commander\./.test((error as Error).name ?? '')) {
    console.error(message);
  }
  process.exit(exitCode);
}

function parseAgent(value: unknown): 'claude' | 'codex' | undefined {
  if (value === undefined) return undefined;
  if (value === 'claude' || value === 'codex') return value;
  throw new KaizenError(`Invalid agent: ${String(value)}`, 2);
}

function parseTrigger(value: unknown): 'manual' | 'scheduled' | 'instant' | 'watch' | undefined {
  if (value === undefined) return undefined;
  if (value === 'manual' || value === 'scheduled' || value === 'instant' || value === 'watch') return value;
  throw new KaizenError(`Invalid trigger: ${String(value)}`, 2);
}

function parseSchedule(value: unknown): string {
  if (typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
  throw new KaizenError(`Invalid schedule: ${String(value)}`, 2);
}

function parsePriority(value: unknown): 'P0' | 'P1' | 'P2' {
  if (value === 'P0' || value === 'P1' || value === 'P2') return value;
  throw new KaizenError(`Invalid priority: ${String(value)}`, 2);
}

function queueForReport(value: unknown, now: boolean): boolean | undefined {
  if (value === true || value === false) return value;
  return now ? true : undefined;
}

function parseIssueArguments(values: unknown): number[] {
  if (!Array.isArray(values) || values.length === 0) throw new KaizenError('At least one issue number is required', 2);
  return values.map((value) => {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    throw new KaizenError(`Invalid issue number: ${String(value)}`, 2);
  });
}

async function resolveBody(body: string, bodyFile: string | undefined): Promise<string> {
  if (!bodyFile) return body;
  if (bodyFile === '-') {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => resolve(data));
    });
  }
  const fs = await import('node:fs/promises');
  return fs.readFile(bodyFile, 'utf8');
}

async function promptDirectCommit(context: DirectCommitConfirmation): Promise<'direct' | 'pr' | 'reject'> {
  const verify = context.verifyResults.length
    ? context.verifyResults.map((result) => `${result.command}: ${result.ok ? 'passed' : 'failed'}`).join(', ')
    : 'not configured';
  console.error(`Verification: ${verify}`);
  console.error(`Risk: ${context.decision.reason}`);
  console.error(`Diff: ${context.diff.changedLines} changed lines / ${context.diff.changedFiles} files`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`Push direct commit for issue #${context.issue.number}? [Y=push / p=PR / n=reject] `)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') return 'direct';
    if (answer === 'p' || answer === 'pr') return 'pr';
    return 'reject';
  } finally {
    rl.close();
  }
}

function print(value: unknown, json = false): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === 'object' && value && 'selected' in value) {
    const selection = value as { selected: Array<{ number: number; title: string }>; skipped: Array<{ number: number; reason: string }> };
    console.log('Selected issues:');
    for (const issue of selection.selected) console.log(`- #${issue.number} ${issue.title}`);
    if (selection.skipped.length > 0) {
      console.log('Skipped issues:');
      for (const issue of selection.skipped) console.log(`- #${issue.number}: ${issue.reason}`);
    }
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}
