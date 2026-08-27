import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { DEFAULT_ENV_ALLOWLIST } from '../utils/command.js';
import { ConfigError } from '../utils/errors.js';
import { DEFAULT_FORBIDDEN_PATHS, DEFAULT_PROTECTED_PATHS, configSchema } from './schema.js';
export async function loadConfig(repoDir) {
    const configPath = path.join(repoDir, '.kaizen', 'config.yml');
    let raw;
    try {
        raw = await fs.readFile(configPath, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            throw new ConfigError(`Missing Kaizen config: ${configPath}`);
        }
        throw new ConfigError(`Unable to read Kaizen config at ${configPath}: ${String(error)}`);
    }
    try {
        return configSchema.parse(parse(raw));
    }
    catch (error) {
        throw new ConfigError(`Invalid Kaizen config at ${configPath}: ${String(error)}`);
    }
}
export function defaultConfigYaml(options) {
    return stringify(defaultConfigObject(options));
}
export function defaultConfigObject(options) {
    return {
        version: 1,
        execution: {
            runner: {
                provider: 'local'
            },
            builder: {
                primary: {
                    provider: options.agent,
                    model: null
                },
                fallback: {
                    provider: options.agent === 'claude' ? 'codex' : 'claude',
                    model: null
                }
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
            operationMode: 'external',
            minFreeDiskMb: 1024,
            wipLimit: 5,
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
            timeoutMinutes: 15,
            expectedRepository: 'https://github.com/kaizen-agents-org/verifier.git',
            expectedRef: options.expectedVerifierRef ?? 'refs/heads/main',
            freshnessTimeoutSeconds: 30
        },
        guardian: {
            enabled: true,
            mode: 'sync',
            command: 'codex',
            timeoutMinutes: 60,
            maxAttempts: 5,
            reviewSettleSeconds: 30
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
            protectedPaths: DEFAULT_PROTECTED_PATHS,
            forbiddenPaths: DEFAULT_FORBIDDEN_PATHS
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
            issueComments: true,
            starvationRuns: 2
        },
        issues: {
            label: 'kaizen',
            executionAuthorization: {
                label: 'kaizen:authorized',
                minimumPermission: 'triage'
            },
            selection: {
                mode: 'auto',
                includeLabel: 'kaizen:ready',
                excludeLabels: ['kaizen:needs-human']
            },
            priorityOrder: ['kaizen:P0', 'kaizen:P1', 'kaizen:P2']
        }
    };
}
//# sourceMappingURL=config.js.map