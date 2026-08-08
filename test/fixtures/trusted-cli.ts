import path from 'node:path';
import {
  COMMAND_RUNNER_INJECTION,
  runCommand,
  withTrustedExecutables,
  type CommandRunner
} from '../../src/utils/command.js';

const binDir = process.env.KAIZEN_TEST_TRUSTED_BIN;
if (!binDir) throw new Error('KAIZEN_TEST_TRUSTED_BIN is required.');

(globalThis as typeof globalThis & { [COMMAND_RUNNER_INJECTION]?: CommandRunner })[COMMAND_RUNNER_INJECTION] =
  withTrustedExecutables(runCommand, {
    git: path.join(binDir, 'git'),
    githubCli: path.join(binDir, 'gh'),
    ssh: '/bin/sh',
    githubToken: 'test-publication-token'
  });

await import('../../src/cli.js');
