import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { DEFAULT_ENV_ALLOWLIST } from '../utils/command.js';
import { ConfigError } from '../utils/errors.js';
import { configSchema, type KaizenConfig } from './schema.js';

export async function loadConfig(repoDir: string): Promise<KaizenConfig> {
  const configPath = path.join(repoDir, '.kaizen', 'config.yml');
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Missing Kaizen config: ${configPath}`);
  }

  try {
    return configSchema.parse(parse(raw));
  } catch (error) {
    throw new ConfigError(`Invalid Kaizen config at ${configPath}: ${String(error)}`);
  }
}

export function defaultConfigYaml(options: {
  agent: 'claude' | 'codex';
  schedule?: string;
  setup: string | null;
  verify: string[];
}): string {
  return stringify({
    version: 1,
    agent: {
      default: options.agent,
      fallback: true,
      model: {
        claude: null,
        codex: null
      }
    },
    run: {
      maxIssuesPerNight: 3,
      issueTimeoutMinutes: 120,
      runTimeoutMinutes: 240,
      maxVerifyRetries: 2,
      maxAttemptsPerIssue: 3,
      maxOpenPullRequests: 1,
      latestStartHour: 7
    },
    safety: {
      minFreeDiskMb: 1024,
      envAllowlist: DEFAULT_ENV_ALLOWLIST
    },
    scheduler: {
      jobs: {
        maintenance: {
          enabled: true,
          schedule: {
            type: 'daily',
            time: options.schedule ?? '02:00'
          },
          run: {
            mode: 'maintenance',
            lateStartGuard: true
          }
        },
        'issue-watch': {
          enabled: false,
          schedule: {
            type: 'interval',
            everyMinutes: 5
          },
          run: {
            mode: 'watch',
            skipIfRunning: true
          }
        }
      }
    },
    commands: {
      setup: options.setup,
      verify: options.verify,
      verifyTimeoutMinutes: 15
    },
    builder: {
      command: 'builder-agent',
      resultPath: '.kaizen/builder/build-result.json'
    },
    verifier: {
      enabled: true,
      command: 'verifier',
      resultPath: '.kaizen/verifier/verify-result.json',
      timeoutMinutes: 15
    },
    guardian: {
      enabled: true,
      mode: 'sync',
      command: 'codex',
      timeoutMinutes: 60,
      maxAttempts: 5
    },
    goal: {
      maxIterations: 5,
      issueLabel: 'kaizen:goal',
      evaluation: {
        command: null,
        timeoutMinutes: 15
      },
      agent: {
        command: 'codex',
        args: ['exec', '--sandbox', 'read-only', '-'],
        resultPath: 'goal-result.json',
        timeoutMinutes: 20
      }
    },
    policy: {
      mode: 'pr-only',
      directCommit: {
        maxChangedLines: 150,
        maxChangedFiles: 5
      },
      protectedPaths: ['.github/**', '**/.env*', '**/secrets/**', '**/*migration*/**', 'Dockerfile', '.kaizen/**'],
      forbiddenPaths: ['**/.git/**']
    },
    git: {
      defaultBranch: 'main',
      branchPrefix: 'kaizen/',
      commitMessageFormat: 'kaizen: {summary} (#{issue})'
    },
    instant: {
      unattendedMode: 'pr'
    },
    report: {
      notification: true,
      issueComments: true
    },
    issues: {
      label: 'kaizen',
      selection: {
        mode: 'auto',
        includeLabel: 'kaizen:ready',
        excludeLabels: ['kaizen:needs-human']
      },
      priorityOrder: ['kaizen:P0', 'kaizen:P1', 'kaizen:P2']
    }
  });
}
