import { withTrustedExecutables, type CommandRunner } from '../../src/utils/command.js';

const TEST_GIT = '/trusted/bin/git';
const TEST_GH = '/trusted/bin/gh';
const TEST_SSH = '/trusted/bin/ssh';
const TEST_TOKEN_COMMAND = '/trusted/bin/github-token';

export function trustedRunner(
  command: CommandRunner,
  options: { githubToken?: string | false; githubTokenCommand?: string | false } = {}
): CommandRunner {
  const mapped: CommandRunner = (executable, args, options) => command(
    executable === TEST_GIT ? 'git' : executable === TEST_GH ? 'gh' : executable === TEST_SSH ? 'ssh' : executable === TEST_TOKEN_COMMAND ? 'github-token' : executable,
    args,
    options
  );
  return withTrustedExecutables(mapped, {
    git: TEST_GIT,
    githubCli: TEST_GH,
    ssh: TEST_SSH,
    githubToken: options.githubToken === false ? undefined : options.githubToken ?? 'test-publication-token',
    githubTokenCommand: options.githubTokenCommand === false ? undefined : options.githubTokenCommand ?? TEST_TOKEN_COMMAND
  });
}
