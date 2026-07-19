import { z } from 'zod';
import { DEFAULT_ENV_ALLOWLIST } from '../utils/command.js';
import { isProjectSlug } from '../utils/slug.js';

const nullableString = z.string().nullable().optional();
const timeString = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const jobIdString = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const DEFAULT_PROTECTED_PATHS = [
  '.github/**',
  '.gitlab-ci.yml',
  '.circleci/**',
  'azure-pipelines.yml',
  'Jenkinsfile',
  '**/.env*',
  '**/secrets/**',
  '**/*migration*/**',
  '**/*release*/**',
  '**/*publish*/**',
  '.npmrc',
  '.pypirc',
  'Dockerfile',
  '.kaizen/**'
];

export const DEFAULT_FORBIDDEN_PATHS = [
  '**/.git/**',
  '**/.ssh/**',
  '**/.gnupg/**',
  '**/*credential*/**',
  '**/*.pem',
  '**/*.key'
];

const schedulerScheduleSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('interval'),
      everyMinutes: z.number().int().min(1).max(1439).optional(),
      everyHours: z.number().int().min(1).max(23).optional(),
      anchorTime: timeString.optional()
    })
    .strict()
    .superRefine((value, context) => {
      const units = Number(value.everyMinutes !== undefined) + Number(value.everyHours !== undefined);
      if (units !== 1) {
        context.addIssue({
          code: 'custom',
          message: 'interval schedule must set exactly one of everyMinutes or everyHours'
        });
      }
      if (value.everyMinutes !== undefined && value.anchorTime !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'anchorTime is not supported with everyMinutes intervals'
        });
      }
    }),
  z.object({ type: z.literal('times'), times: z.array(timeString).min(1) }).strict(),
  z.object({ type: z.literal('daily'), time: timeString }).strict(),
  z
    .object({
      type: z.literal('weekly'),
      days: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).min(1),
      time: timeString
    })
    .strict(),
  z.object({ type: z.literal('rrule'), value: z.string().min(1) }).strict()
]);

const schedulerRunSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('maintenance'),
      lateStartGuard: z.boolean().default(false),
      maxIssues: z.number().int().positive().optional()
    })
    .strict(),
  z
    .object({
      mode: z.literal('watch'),
      skipIfRunning: z.boolean().default(true),
      maxIssues: z.number().int().positive().optional()
    })
    .strict(),
  z.object({ mode: z.literal('smoke') }).strict()
]);

const schedulerJobSchema = z
  .object({
    enabled: z.boolean().default(true),
    schedule: schedulerScheduleSchema,
    run: schedulerRunSchema
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    agent: z
      .object({
        default: z.enum(['claude', 'codex']).default('claude'),
        fallback: z.boolean().default(true),
        model: z
          .object({
            claude: nullableString,
            codex: nullableString
          })
          .strict()
          .default({ claude: null, codex: null })
      })
      .strict()
      .default({ default: 'claude', fallback: true, model: { claude: null, codex: null } }),
    run: z
      .object({
        maxIssuesPerNight: z.number().int().positive().default(3),
        issueTimeoutMinutes: z.number().int().positive().default(120),
        runTimeoutMinutes: z.number().int().positive().default(240),
        maxVerifyRetries: z.number().int().min(0).default(2),
        maxAttemptsPerIssue: z.number().int().positive().default(3),
        maxOpenPullRequests: z.number().int().nonnegative().default(1),
        latestStartHour: z.number().int().min(0).max(23).default(7)
      })
      .strict()
      .default({
        maxIssuesPerNight: 3,
        issueTimeoutMinutes: 120,
        runTimeoutMinutes: 240,
        maxVerifyRetries: 2,
        maxAttemptsPerIssue: 3,
        maxOpenPullRequests: 1,
        latestStartHour: 7
      }),
    safety: z
      .object({
        operationMode: z.enum(['external', 'dogfood']).default('external'),
        minFreeDiskMb: z.number().int().nonnegative().default(1024),
        wipLimit: z.number().int().nonnegative().default(5),
        envAllowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default(DEFAULT_ENV_ALLOWLIST)
      })
      .strict()
      .default({
        operationMode: 'external',
        minFreeDiskMb: 1024,
        wipLimit: 5,
        envAllowlist: DEFAULT_ENV_ALLOWLIST
      }),
    scheduler: z
      .object({
        provider: z.enum(['launchd', 'cron', 'codex-automation', 'claude-routine', 'external']).optional(),
        jobs: z.record(jobIdString, schedulerJobSchema).default({})
      })
      .strict()
      .default({
        jobs: {
          maintenance: {
            enabled: true,
            schedule: { type: 'daily', time: '02:00' },
            run: { mode: 'maintenance', lateStartGuard: true }
          },
          'issue-watch': {
            enabled: false,
            schedule: { type: 'interval', everyMinutes: 5 },
            run: { mode: 'watch', skipIfRunning: true }
          }
        }
      }),
    commands: z
      .object({
        setup: z.string().nullable().default(null),
        verify: z.array(z.string()).default([]),
        verifyTimeoutMinutes: z.number().int().positive().default(15)
      })
      .strict()
      .default({ setup: null, verify: [], verifyTimeoutMinutes: 15 }),
    builder: z
      .object({
        command: z.string().default('builder-agent'),
        resultPath: z.string().default('.kaizen/builder/build-result.json')
      })
      .strict()
      .default({ command: 'builder-agent', resultPath: '.kaizen/builder/build-result.json' }),
    verifier: z
      .object({
        enabled: z.boolean().default(true),
        command: z.string().default('verifier'),
        resultPath: z.string().default('.kaizen/verifier/verify-result.json'),
        timeoutMinutes: z.number().int().positive().default(15)
      })
      .strict()
      .default({
        enabled: true,
        command: 'verifier',
        resultPath: '.kaizen/verifier/verify-result.json',
        timeoutMinutes: 15
      }),
    guardian: z
      .object({
        enabled: z.boolean().default(true),
        mode: z.enum(['sync', 'async']).default('sync'),
        command: z.string().default('codex'),
        timeoutMinutes: z.number().int().positive().default(60),
        maxAttempts: z.number().int().positive().default(5),
        reviewSettleSeconds: z.number().int().min(0).default(30)
      })
      .strict()
      .default({
        enabled: true,
        mode: 'sync',
        command: 'codex',
        timeoutMinutes: 60,
        maxAttempts: 5,
        reviewSettleSeconds: 30
      }),
    goal: z
      .object({
        maxIterations: z.number().int().positive().default(5),
        issueLabel: z.string().default('kaizen:goal'),
        evaluation: z
          .object({
            command: z.string().nullable().default(null),
            timeoutMinutes: z.number().int().positive().default(15)
          })
          .strict()
          .default({ command: null, timeoutMinutes: 15 }),
        agent: z
          .object({
            command: z.string().default('codex'),
            args: z.array(z.string()).default(['exec', '--sandbox', 'read-only', '-']),
            resultPath: z.string().default('goal-result.json'),
            timeoutMinutes: z.number().int().positive().default(20)
          })
          .strict()
          .default({
            command: 'codex',
            args: ['exec', '--sandbox', 'read-only', '-'],
            resultPath: 'goal-result.json',
            timeoutMinutes: 20
          })
      })
      .strict()
      .default({
        maxIterations: 5,
        issueLabel: 'kaizen:goal',
        evaluation: { command: null, timeoutMinutes: 15 },
        agent: {
          command: 'codex',
          args: ['exec', '--sandbox', 'read-only', '-'],
          resultPath: 'goal-result.json',
          timeoutMinutes: 20
        }
      }),
    policy: z
      .object({
        mode: z.enum(['hybrid', 'pr-only', 'direct-only']).default('pr-only'),
        directCommit: z
          .object({
            maxChangedLines: z.number().int().nonnegative().default(150),
            maxChangedFiles: z.number().int().nonnegative().default(5)
          })
          .strict()
          .default({ maxChangedLines: 150, maxChangedFiles: 5 }),
        protectedPaths: z
          .array(z.string())
          .default(DEFAULT_PROTECTED_PATHS),
        forbiddenPaths: z.array(z.string()).default(DEFAULT_FORBIDDEN_PATHS)
      })
      .strict()
      .default({
        mode: 'pr-only',
        directCommit: { maxChangedLines: 150, maxChangedFiles: 5 },
        protectedPaths: DEFAULT_PROTECTED_PATHS,
        forbiddenPaths: DEFAULT_FORBIDDEN_PATHS
      }),
    git: z
      .object({
        defaultBranch: z.string().default('main'),
        branchPrefix: z.string().default('kaizen/'),
        commitMessageFormat: z.string().default('kaizen: {summary} (#{issue})')
      })
      .strict()
      .default({
        defaultBranch: 'main',
        branchPrefix: 'kaizen/',
        commitMessageFormat: 'kaizen: {summary} (#{issue})'
      }),
    instant: z
      .object({
        unattendedMode: z.enum(['pr', 'direct', 'reject']).default('pr')
      })
      .strict()
      .default({ unattendedMode: 'pr' }),
    report: z
      .object({
        notification: z.boolean().default(true),
        issueComments: z.boolean().default(true)
      })
      .strict()
      .default({ notification: true, issueComments: true }),
    issues: z
      .object({
        label: z.string().default('kaizen'),
        executionAuthorization: z
          .object({
            label: z.string().default('kaizen:authorized'),
            minimumPermission: z.enum(['triage', 'write', 'maintain', 'admin']).default('triage')
          })
          .strict()
          .default({ label: 'kaizen:authorized', minimumPermission: 'triage' }),
        selection: z
          .object({
            mode: z.enum(['auto', 'opt-in', 'manual-only']).default('auto'),
            includeLabel: z.string().default('kaizen:ready'),
            excludeLabels: z.array(z.string()).default(['kaizen:needs-human'])
          })
          .strict()
          .default({ mode: 'auto', includeLabel: 'kaizen:ready', excludeLabels: ['kaizen:needs-human'] }),
        priorityOrder: z.array(z.string()).default(['kaizen:P0', 'kaizen:P1', 'kaizen:P2'])
      })
      .strict()
      .default({
        label: 'kaizen',
        executionAuthorization: { label: 'kaizen:authorized', minimumPermission: 'triage' },
        selection: { mode: 'auto', includeLabel: 'kaizen:ready', excludeLabels: ['kaizen:needs-human'] },
        priorityOrder: ['kaizen:P0', 'kaizen:P1', 'kaizen:P2']
      })
  })
  .strict()
  .superRefine((config, context) => {
    if (config.safety.operationMode === 'external' && !config.verifier.enabled) {
      context.addIssue({
        code: 'custom',
        path: ['verifier', 'enabled'],
        message: 'verifier.enabled cannot be false when safety.operationMode is external'
      });
    }
    if (config.safety.operationMode === 'external' && config.verifier.command !== 'verifier') {
      context.addIssue({
        code: 'custom',
        path: ['verifier', 'command'],
        message: 'verifier.command must be verifier when safety.operationMode is external'
      });
    }
  });

export type KaizenConfig = z.infer<typeof configSchema>;
export type SchedulerSchedule = z.infer<typeof schedulerScheduleSchema>;
export type SchedulerRun = z.infer<typeof schedulerRunSchema>;
export type SchedulerJobConfig = z.infer<typeof schedulerJobSchema>;

export const registryProjectSchema = z
  .object({
    repo: z.string(),
    localPath: z.string(),
    workspacePath: z.string(),
    schedule: z.string(),
    enabled: z.boolean(),
    createdAt: z.string(),
    lastRun: z
      .object({
        startedAt: z.string(),
        finishedAt: z.string(),
        result: z.string(),
        processed: z.number().int().nonnegative(),
        fixed: z.number().int().nonnegative(),
        prCreated: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative()
      })
      .strict()
      .optional()
  })
  .strict();

export const registrySchema = z
  .object({
    version: z.literal(1),
    projects: z.record(z.string().refine(isProjectSlug, { message: 'Invalid project slug' }), registryProjectSchema)
  })
  .strict();

export type Registry = z.infer<typeof registrySchema>;
export type RegistryProject = z.infer<typeof registryProjectSchema>;
