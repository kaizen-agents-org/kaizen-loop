import { withTrustedExecutables, type CommandRunner, type GitHubPublicationRequest } from '../../src/utils/command.js';

const TEST_GIT = '/trusted/bin/git';
const TEST_GH = '/trusted/bin/gh';
const TEST_SSH = '/trusted/bin/ssh';

export function trustedRunner(
  command: CommandRunner,
  options: {
    githubToken?: string | false;
    githubPublisher?: ((request: GitHubPublicationRequest) => Promise<void>) | false;
  } = {}
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
    githubPublisher: options.githubPublisher === false ? undefined : options.githubPublisher
  });
}
