import { z } from 'zod';

const nullableString = z.string().nullable().optional();
const timeString = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

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
        latestStartHour: z.number().int().min(0).max(23).default(7)
      })
      .strict()
      .default({
        maxIssuesPerNight: 3,
        issueTimeoutMinutes: 120,
        runTimeoutMinutes: 240,
        maxVerifyRetries: 2,
        maxAttemptsPerIssue: 3,
        latestStartHour: 7
      }),
    scheduler: z
      .object({
        nightly: z
          .object({
            enabled: z.boolean().default(true),
            time: timeString.default('02:00')
          })
          .strict()
          .default({ enabled: true, time: '02:00' }),
        afternoon: z
          .object({
            enabled: z.boolean().default(false),
            time: timeString.default('14:00')
          })
          .strict()
          .default({ enabled: false, time: '14:00' }),
        poll: z
          .object({
            enabled: z.boolean().default(false),
            intervalMinutes: z.number().int().min(1).max(59).default(5),
            skipIfRunning: z.boolean().default(true)
          })
          .strict()
          .default({ enabled: false, intervalMinutes: 5, skipIfRunning: true })
      })
      .strict()
      .default({
        nightly: { enabled: true, time: '02:00' },
        afternoon: { enabled: false, time: '14:00' },
        poll: { enabled: false, intervalMinutes: 5, skipIfRunning: true }
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
        command: z.string().default('codex'),
        timeoutMinutes: z.number().int().positive().default(60),
        maxAttempts: z.number().int().positive().default(5)
      })
      .strict()
      .default({
        enabled: true,
        command: 'codex',
        timeoutMinutes: 60,
        maxAttempts: 5
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
          .default(['.github/**', '**/.env*', '**/secrets/**', '**/*migration*/**', 'Dockerfile', '.kaizen/**']),
        forbiddenPaths: z.array(z.string()).default(['**/.git/**'])
      })
      .strict()
      .default({
        mode: 'pr-only',
        directCommit: { maxChangedLines: 150, maxChangedFiles: 5 },
        protectedPaths: ['.github/**', '**/.env*', '**/secrets/**', '**/*migration*/**', 'Dockerfile', '.kaizen/**'],
        forbiddenPaths: ['**/.git/**']
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
        selection: { mode: 'auto', includeLabel: 'kaizen:ready', excludeLabels: ['kaizen:needs-human'] },
        priorityOrder: ['kaizen:P0', 'kaizen:P1', 'kaizen:P2']
      })
  })
  .strict();

export type KaizenConfig = z.infer<typeof configSchema>;

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
    projects: z.record(z.string(), registryProjectSchema)
  })
  .strict();

export type Registry = z.infer<typeof registrySchema>;
export type RegistryProject = z.infer<typeof registryProjectSchema>;
