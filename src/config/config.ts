import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
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
      latestStartHour: 7
    },
    scheduler: {
      nightly: {
        enabled: true,
        time: options.schedule ?? '02:00'
      },
      poll: {
        enabled: false,
        intervalMinutes: 5,
        skipIfRunning: true
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
      command: 'codex',
      timeoutMinutes: 60,
      maxAttempts: 5
    },
    policy: {
      mode: 'hybrid',
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
