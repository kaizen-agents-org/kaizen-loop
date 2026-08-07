import { withTrustedExecutables, type CommandRunner } from '../../src/utils/command.js';

const TEST_GIT = '/trusted/bin/git';
const TEST_GH = '/trusted/bin/gh';
const TEST_SSH = '/trusted/bin/ssh';

export function trustedRunner(
  command: CommandRunner,
  options: { githubToken?: string | false; githubTokenProvider?: (() => Promise<string>) | false } = {}
): CommandRunner {
  const mapped: CommandRunner = (executable, args, options) => command(
    executable === TEST_GIT ? 'git' : executable === TEST_GH ? 'gh' : executable === TEST_SSH ? 'ssh' : executable,
    args,
    options
  );
  return withTrustedExecutables(mapped, {
    git: TEST_GIT,
    githubCli: TEST_GH,
    ssh: TEST_SSH,
    githubToken: options.githubToken === false ? undefined : options.githubToken ?? 'test-publication-token',
    githubTokenProvider: options.githubTokenProvider === false ? undefined : options.githubTokenProvider
  });
}
