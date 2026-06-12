#!/usr/bin/env node
import { Command } from 'commander';
import { initProject } from './init/init.js';
import { runKaizen } from './orchestrator/run.js';
import { loadRegistry } from './config/registry.js';
import { runCommand } from './utils/command.js';
import { KaizenError } from './utils/errors.js';

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
      message: 'Kaizen Loop initialized. Scheduler registration is not implemented in Phase 1.',
      ...result
    }, Boolean(options.json ?? globals.json));
  });

program
  .command('run')
  .description('run the Phase 1 maintenance pipeline once')
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

for (const command of ['fix', 'report', 'watch', 'status', 'enable', 'disable', 'logs', 'doctor']) {
  program
    .command(command, { hidden: false })
    .description('not implemented in Phase 1')
    .action(() => {
      throw new KaizenError(`kaizen ${command} is not implemented in Phase 1.`, 2);
    });
}

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
