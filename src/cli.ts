#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parse, stringify } from 'yaml';
import { initProject } from './init/init.js';
import { type DirectCommitConfirmation, runKaizen } from './orchestrator/run.js';
import { loadRegistry, resolveProject, saveRegistry } from './config/registry.js';
import { loadConfig } from './config/config.js';
import { runCommand } from './utils/command.js';
import { KaizenError } from './utils/errors.js';
import { reportIssue, reportIssueNow } from './commands/report.js';
import { listQueuedIssues, queueIssues, unqueueIssues } from './commands/queue.js';
import { planImprove, runImprove } from './commands/improve.js';
import { createGoal, goalStatus, listGoals, runGoalCommand, stopGoal } from './commands/goal.js';
import { statusProject } from './commands/status.js';
import { followLogs, readLogs } from './commands/logs.js';
import { listGuardianJobs, runGuardianForPullRequest, watchGuardianJobs } from './commands/guardian.js';
import { doctorProject } from './commands/doctor.js';
import { fleetHasFailures, refreshFleet, syncFleet } from './commands/fleet.js';
import { disableScheduler, enableScheduler, schedulerJobs } from './scheduler/scheduler.js';
import type { SchedulerRun, SchedulerSchedule } from './config/schema.js';

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
  .option('--trigger <trigger>', 'trigger override: manual, scheduled, afternoon, instant, or watch')
  .option('--job <job>', 'scheduler job id to run')
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
      job: parseJob(options.job),
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

const fleet = program
  .command('fleet')
  .description('rebuild registry, workspaces, labels, and scheduler jobs for a repo fleet')
  .option('--root <path>', 'directory containing target repository checkouts')
  .option('--owner <owner>', 'GitHub owner to include')
  .option('--repo <repo...>', 'repo name or owner/repo to include; repeat for multiple repos')
  .option('--no-config', 'do not migrate legacy .kaizen/config.yml scheduler settings')
  .option('--no-workspace', 'do not create or repair Kaizen workspaces')
  .option('--no-labels', 'do not create or repair GitHub labels')
  .option('--no-scheduler', 'do not sync launchd or cron jobs')
  .option('--no-lock-repair', 'do not remove stale run locks')
  .option('--verify', 'sync each fleet workspace to its default branch and run setup plus verify commands', false)
  .option('--prune', 'remove registry entries that were not discovered under --root', false)
  .option('--dry-run', 'plan changes without modifying files, registry, GitHub, workspaces, or scheduler jobs', false)
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ json?: boolean }>();
    const result = await syncFleet({
      cwd: process.cwd(),
      root: options.root,
      owner: options.owner,
      repos: options.repo,
      migrateConfig: options.config !== false,
      ensureWorkspace: options.workspace !== false,
      ensureLabels: options.labels !== false,
      syncScheduler: options.scheduler !== false,
      repairLocks: options.lockRepair !== false,
      verify: Boolean(options.verify),
      prune: Boolean(options.prune),
      dryRun: Boolean(options.dryRun),
      runCommand
    });
    if (fleetHasFailures(result)) process.exitCode = 1;
    print(result, Boolean(options.json ?? globals.json));
  });

fleet
  .command('refresh')
  .description('verify registered workspaces are ready for the next monitor pass')
  .option('--project <slug>', 'target project slug')
  .option('--sync', 'fetch, reset to the default branch, and clean each workspace before verification', false)
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const result = await refreshFleet({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      sync: Boolean(options.sync),
      runCommand
    });
    print(result, Boolean(options.json ?? globals.json));
    if (!result.ok) process.exitCode = 1;
  });

const scheduler = program
  .command('scheduler')
  .description('manage scheduler provider jobs');

scheduler
  .command('status')
  .description('show configured scheduler jobs')
  .option('--project <slug>', 'target project slug')
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const resolved = await resolveProject(options.project ?? globals.project, process.cwd());
    const config = await loadConfig(resolved.project.localPath);
    print({
      slug: resolved.slug,
      provider: config.scheduler.provider ?? defaultSchedulerProvider(),
      enabled: resolved.project.enabled,
      jobs: schedulerJobs(config)
    }, Boolean(options.json ?? globals.json));
  });

scheduler
  .command('plan')
  .description('show scheduler jobs that sync would install')
  .option('--project <slug>', 'target project slug')
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const resolved = await resolveProject(options.project ?? globals.project, process.cwd());
    const config = await loadConfig(resolved.project.localPath);
    print({
      slug: resolved.slug,
      provider: config.scheduler.provider ?? defaultSchedulerProvider(),
      actions: schedulerJobs(config).map((job) => ({ action: 'sync', job: job.name, schedule: job.config.schedule, run: job.config.run }))
    }, Boolean(options.json ?? globals.json));
  });

scheduler
  .command('sync')
  .description('sync configured scheduler jobs to launchd or cron')
  .option('--project <slug>', 'target project slug')
  .option('--schedule <HH:MM>', 'legacy maintenance schedule override')
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const resolved = await resolveProject(options.project ?? globals.project, process.cwd());
    const registry = await loadRegistry();
    const project = registry.projects[resolved.slug];
    const config = await loadConfig(project.localPath);
    const schedule = parseSchedule(options.schedule ?? project.schedule);
    const result = await enableScheduler({ slug: resolved.slug, project, config, runCommand });
    project.enabled = true;
    project.schedule = schedule;
    await saveRegistry(registry);
    print({ slug: resolved.slug, enabled: true, scheduler: result }, Boolean(options.json ?? globals.json));
  });

scheduler
  .command('set-schedule')
  .description('update a scheduler job schedule in .kaizen/config.yml')
  .requiredOption('--job <job>', 'scheduler job id')
  .option('--project <slug>', 'target project slug')
  .option('--daily <HH:MM>', 'run once per day at HH:MM')
  .option('--times <HH:MM,...>', 'run daily at comma-separated times')
  .option('--every-hours <number>', 'run every N hours')
  .option('--every-minutes <number>', 'run every N minutes')
  .option('--anchor-time <HH:MM>', 'anchor time for hourly intervals')
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const resolved = await resolveProject(options.project ?? globals.project, process.cwd());
    const job = parseJob(options.job);
    if (!job) throw new KaizenError('--job is required', 2);
    const schedule = parseSchedulerScheduleOptions(options);
    const configPath = path.join(resolved.project.localPath, '.kaizen', 'config.yml');
    const raw = parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    const schedulerConfig = ensureRecord(raw, 'scheduler');
    const jobs = ensureRecord(schedulerConfig, 'jobs');
    const jobConfig = ensureRecord(jobs, job);
    if (typeof jobConfig.enabled !== 'boolean') jobConfig.enabled = true;
    if (!isRecord(jobConfig.run)) jobConfig.run = defaultSchedulerRun(schedule);
    jobConfig.schedule = schedule;
    await fs.writeFile(configPath, stringify(raw));
    print({ slug: resolved.slug, job, schedule }, Boolean(options.json ?? globals.json));
  });

scheduler
  .command('disable')
  .description('disable scheduler jobs for a project')
  .option('--project <slug>', 'target project slug')
  .option('--all', 'disable all registered projects', false)
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const registry = await loadRegistry();
    const resolved = options.all ? undefined : await resolveProject(options.project ?? globals.project, process.cwd());
    const targets = options.all
      ? Object.entries(registry.projects)
      : [[resolved!.slug, registry.projects[resolved!.slug]] as const];
    const results = [];
    for (const [slug, project] of targets) {
      const schedulerResult = await disableScheduler({ slug, runCommand, terminateRunning: true });
      project.enabled = false;
      results.push({ slug, enabled: false, scheduler: schedulerResult });
    }
    await saveRegistry(registry);
    print(results, Boolean(options.json ?? globals.json));
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
  .command('improve')
  .description('plan and run the improvement loop over queued Kaizen issues')
  .option('--project <slug>', 'target project slug')
  .option('--issue <numbers>', 'comma-separated issue numbers to process')
  .option('--dry-run', 'show the improvement plan without modifying workspaces or GitHub', false)
  .option('--max-issues <number>', 'override max issues for this run')
  .option('--agent <agent>', 'agent override: claude or codex')
  .option('--yes', 'run without the improvement plan confirmation', false)
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const json = Boolean(options.json ?? globals.json);
    const assumeYes = Boolean(options.yes);
    const issueNumbers = parseIssueNumbers(options.issue);
    const maxIssues = parseOptionalPositiveInteger(options.maxIssues, 'max-issues');
    const improveOptions = {
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      issueNumbers,
      dryRun: Boolean(options.dryRun),
      maxIssues,
      agent: parseAgent(options.agent),
      json,
      runCommand
    };
    const plan = await planImprove(improveOptions);
    if (options.dryRun) {
      print(plan, json);
      return;
    }
    if (plan.selected.length === 0) {
      print(plan, json);
      return;
    }
    if (!assumeYes) {
      if (json || !process.stdin.isTTY || !process.stdout.isTTY) {
        throw new KaizenError('Use --yes to run improve non-interactively', 2);
      }
      printImprovePlan(plan);
      const confirmed = await promptImprove(plan);
      if (!confirmed) {
        console.error('Improvement cancelled.');
        return;
      }
    }
    const result = await runImprove({
      ...improveOptions,
      dryRun: false,
      confirmDirectCommit: !assumeYes && !json && process.stdin.isTTY && process.stdout.isTTY
        ? promptDirectCommit
        : undefined
    });
    print(result, json);
  });

const goal = program
  .command('goal')
  .description('manage multi-iteration Kaizen goals');

goal
  .command('create')
  .description('create a Goal for iterative design, implementation, test, and evaluation')
  .argument('<title>', 'goal title')
  .option('--project <slug>', 'target project slug')
  .option('--description <description>', 'goal description', '')
  .option('--description-file <path>', 'read goal description from file or stdin with -')
  .option('--success <criteria>', 'success criterion; repeat for multiple criteria', collectOption, [])
  .option('--constraint <constraint>', 'goal constraint; repeat for multiple constraints', collectOption, [])
  .option('--max-iterations <number>', 'maximum automatic iterations')
  .option('--json', 'print machine-readable output')
  .action(async (title, options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const result = await createGoal({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      title,
      description: await resolveBody(options.description, options.descriptionFile),
      successCriteria: options.success,
      constraints: options.constraint,
      maxIterations: parseOptionalPositiveInteger(options.maxIterations, 'max-iterations')
    });
    print(result, Boolean(options.json ?? globals.json));
  });

goal
  .command('run')
  .description('run a Goal until it succeeds, blocks, fails, or reaches max iterations')
  .argument('<goal-id>', 'goal id')
  .option('--project <slug>', 'target project slug')
  .option('--agent <agent>', 'agent override for implementation issues: claude or codex')
  .option('--yes', 'run without interactive confirmations', false)
  .option('--json', 'print machine-readable output')
  .action(async (goalId, options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const json = Boolean(options.json ?? globals.json);
    const assumeYes = Boolean(options.yes);
    if (!assumeYes && (json || !process.stdin.isTTY || !process.stdout.isTTY)) {
      throw new KaizenError('Use --yes to run goal non-interactively', 2);
    }
    const result = await runGoalCommand({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      goalId,
      agent: parseAgent(options.agent),
      assumeYes,
      json,
      confirmDirectCommit: !assumeYes && !json && process.stdin.isTTY && process.stdout.isTTY
        ? promptDirectCommit
        : undefined,
      runCommand
    });
    print(result, json);
  });

goal
  .command('status')
  .description('show Goal status')
  .argument('<goal-id>', 'goal id')
  .option('--project <slug>', 'target project slug')
  .option('--json', 'print machine-readable output')
  .action(async (goalId, options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const result = await goalStatus({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      goalId
    });
    print(result, Boolean(options.json ?? globals.json));
  });

goal
  .command('list')
  .description('list Goals')
  .option('--project <slug>', 'target project slug')
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const result = await listGoals({
      cwd: process.cwd(),
      project: options.project ?? globals.project
    });
    print(result, Boolean(options.json ?? globals.json));
  });

goal
  .command('stop')
  .description('stop an active Goal')
  .argument('<goal-id>', 'goal id')
  .option('--project <slug>', 'target project slug')
  .option('--reason <reason>', 'stop reason', '')
  .option('--json', 'print machine-readable output')
  .action(async (goalId, options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const result = await stopGoal({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      goalId,
      reason: options.reason
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
    const schedule = parseSchedule(options.schedule ?? project.schedule);
    const scheduler = await enableScheduler({ slug: resolved.slug, project, config, runCommand });
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
    const resolved = options.all ? undefined : await resolveProject(options.project ?? globals.project, process.cwd());
    const targets = options.all
      ? Object.entries(registry.projects)
      : [[resolved!.slug, registry.projects[resolved!.slug]] as const];
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
  .option('--guardian', 'show PR Guardian job state', false)
  .option('--follow', 'follow log output until interrupted', false)
  .action(async (options) => {
    const globals = program.opts<{ project?: string }>();
    const logOptions = {
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      run: options.run,
      issue: parseOptionalPositiveInteger(options.issue, 'issue'),
      guardian: Boolean(options.guardian)
    };
    if (options.follow) {
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      process.once('SIGTERM', () => controller.abort());
      await followLogs({ ...logOptions, signal: controller.signal });
      return;
    }
    console.log(await readLogs(logOptions));
  });

const guardian = program
  .command('guardian')
  .description('manage asynchronous PR Guardian jobs');

guardian
  .command('list')
  .description('list PR Guardian jobs')
  .option('--project <slug>', 'target project slug')
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const result = await listGuardianJobs({
      cwd: process.cwd(),
      project: options.project ?? globals.project
    });
    print(result, Boolean(options.json ?? globals.json));
  });

guardian
  .command('run')
  .description('run PR Guardian for one pull request')
  .argument('<pr>', 'pull request number')
  .option('--project <slug>', 'target project slug')
  .option('--json', 'print machine-readable output')
  .action(async (pr, options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const result = await runGuardianForPullRequest({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      pr: parsePositiveInteger(pr, 'pr'),
      runCommand
    });
    print(result, Boolean(options.json ?? globals.json));
  });

guardian
  .command('watch')
  .description('run pending PR Guardian jobs')
  .option('--project <slug>', 'target project slug')
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const globals = program.opts<{ project?: string; json?: boolean }>();
    const result = await watchGuardianJobs({
      cwd: process.cwd(),
      project: options.project ?? globals.project,
      runCommand
    });
    print(result, Boolean(options.json ?? globals.json));
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

function parseTrigger(value: unknown): 'manual' | 'scheduled' | 'afternoon' | 'instant' | 'watch' | undefined {
  if (value === undefined) return undefined;
  if (value === 'manual' || value === 'scheduled' || value === 'afternoon' || value === 'instant' || value === 'watch') return value;
  throw new KaizenError(`Invalid trigger: ${String(value)}`, 2);
}

function parseJob(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) return value;
  throw new KaizenError(`Invalid scheduler job: ${String(value)}`, 2);
}

function parseSchedule(value: unknown): string {
  if (typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
  throw new KaizenError(`Invalid schedule: ${String(value)}`, 2);
}

function parseSchedulerScheduleOptions(options: {
  daily?: string;
  times?: string;
  everyHours?: string;
  everyMinutes?: string;
  anchorTime?: string;
}) {
  const selected = [options.daily, options.times, options.everyHours, options.everyMinutes].filter((value) => value !== undefined);
  if (selected.length !== 1) throw new KaizenError('Specify exactly one of --daily, --times, --every-hours, or --every-minutes.', 2);
  if (options.daily !== undefined) return { type: 'daily' as const, time: parseSchedule(options.daily) };
  if (options.times !== undefined) {
    const times = options.times.split(',').map((time) => parseSchedule(time.trim()));
    if (times.length === 0) throw new KaizenError('Invalid --times: no times provided', 2);
    return { type: 'times' as const, times };
  }
  if (options.everyHours !== undefined) {
    const everyHours = parsePositiveInteger(options.everyHours, 'every-hours');
    if (everyHours > 23) throw new KaizenError('Invalid every-hours: must be between 1 and 23', 2);
    return {
      type: 'interval' as const,
      everyHours,
      ...(options.anchorTime ? { anchorTime: parseSchedule(options.anchorTime) } : {})
    };
  }
  if (options.everyMinutes === undefined) throw new KaizenError('Specify --every-minutes.', 2);
  const everyMinutes = parsePositiveInteger(options.everyMinutes, 'every-minutes');
  if (everyMinutes > 1439) throw new KaizenError('Invalid every-minutes: must be between 1 and 1439', 2);
  return { type: 'interval' as const, everyMinutes };
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (typeof current === 'object' && current !== null && !Array.isArray(current)) return current as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultSchedulerRun(schedule: SchedulerSchedule): SchedulerRun {
  if (schedule.type === 'interval' && schedule.everyMinutes !== undefined) {
    return { mode: 'watch', skipIfRunning: true };
  }
  return { mode: 'maintenance', lateStartGuard: false };
}

function defaultSchedulerProvider(): 'launchd' | 'cron' {
  return process.platform === 'darwin' ? 'launchd' : 'cron';
}

function parseIssueNumbers(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new KaizenError(`Invalid issue list: ${String(value)}`, 2);
  const issueNumbers = value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => parsePositiveInteger(item, 'issue'));
  if (issueNumbers.length === 0) throw new KaizenError('Invalid issue list: no issue numbers provided', 2);
  return [...new Set(issueNumbers)];
}

function parseOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new KaizenError(`Invalid ${name}: ${String(value)}`, 2);
  return parsePositiveInteger(value, name);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new KaizenError(`Invalid ${name}: ${value}`, 2);
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
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

async function promptImprove(plan: { selected: Array<{ number: number; title: string }> }): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`Run improvement for ${plan.selected.length} issue(s)? [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function printImprovePlan(plan: { selected: Array<{ number: number; title: string }>; skipped: Array<{ number: number; reason: string }> }): void {
  console.error('Improvement plan:');
  for (const issue of plan.selected) console.error(`- #${issue.number} ${issue.title}`);
  if (plan.skipped.length > 0) {
    console.error('Skipped issues:');
    for (const issue of plan.skipped) console.error(`- #${issue.number}: ${issue.reason}`);
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
