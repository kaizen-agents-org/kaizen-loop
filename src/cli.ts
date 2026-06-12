#!/usr/bin/env node
import { Command } from 'commander';
import { initProject } from './init/init.js';
import { runKaizen } from './orchestrator/run.js';
import { loadRegistry, resolveProject, saveRegistry } from './config/registry.js';
import { runCommand } from './utils/command.js';
import { KaizenError } from './utils/errors.js';
import { reportIssue } from './commands/report.js';
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
      schedule: options.schedule,
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
  .option('--label <label...>', 'extra label')
  .option('--json', 'print machine-readable output')
  .action(async (title, options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const issue = await reportIssue({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      title,
      body: await resolveBody(options.body, options.bodyFile),
      priority: parsePriority(options.priority),
      direct: Boolean(options.direct),
      prOnly: Boolean(options.prOnly),
      agent: parseAgent(options.agent),
      extraLabels: options.label ?? [],
      runCommand
    });
    print(issue, Boolean(options.json ?? globals.json));
  });

program
  .command('fix')
  .description('process one existing issue immediately')
  .argument('<issue>', 'issue number')
  .option('--project <slug>', 'target project slug')
  .option('--agent <agent>', 'agent override: claude or codex')
  .option('--json', 'print machine-readable output')
  .action(async (issue, options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const json = Boolean(options.json ?? globals.json);
    const result = await runKaizen({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      scheduled: false,
      issue: Number(issue),
      dryRun: false,
      maxIssues: 1,
      agent: parseAgent(options.agent),
      json,
      runCommand
    });
    print(result, json);
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
    const schedule = options.schedule ?? project.schedule;
    const scheduler = await enableScheduler({ slug: resolved.slug, project, schedule, runCommand });
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

function parsePriority(value: unknown): 'P0' | 'P1' | 'P2' {
  if (value === 'P0' || value === 'P1' || value === 'P2') return value;
  throw new KaizenError(`Invalid priority: ${String(value)}`, 2);
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
