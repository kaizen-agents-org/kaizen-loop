import { VerifierAgentAdapter, type VerifierRuntimeInfo } from './verifier.js';
import type { KaizenConfig } from '../config/schema.js';
import { buildUntrustedEnv, type CommandRunner } from '../utils/command.js';

export async function assertVerifierRuntimeFresh(
  config: KaizenConfig,
  runCommand: CommandRunner,
  expectedCommitOverride?: string
): Promise<{ runtime: Extract<VerifierRuntimeInfo, { protocol: 'structured' }>; expectedCommit: string }> {
  const expectedCommit = expectedCommitOverride ?? await resolveExpectedVerifierCommit({ config, runCommand });
  const runtime = await new VerifierAgentAdapter(runCommand, {
    ...config.verifier,
    envAllowlist: config.safety.envAllowlist
  }).inspectRuntime();
  if (runtime.protocol !== 'structured') {
    throw new Error(`legacy verifier cannot be checked against ${config.verifier.expectedRepository} ${config.verifier.expectedRef}`);
  }
  if (runtime.stale) {
    throw new Error(`stale build: built ${runtime.build.commit ?? '<unknown>'}, runtime ${runtime.runtime.commit ?? '<unknown>'}`);
  }
  if (runtime.build.commit !== expectedCommit || runtime.runtime.commit !== expectedCommit) {
    throw new Error(`obsolete build: expected ${expectedCommit}, built ${runtime.build.commit ?? '<unknown>'}, runtime ${runtime.runtime.commit ?? '<unknown>'}`);
  }
  if (runtime.build.dirty !== false || runtime.runtime.dirty !== false) {
    throw new Error(`dirty verifier build or runtime at ${expectedCommit}`);
  }
  return { runtime, expectedCommit };
}

export async function resolveExpectedVerifierCommit(options: {
  config: KaizenConfig;
  runCommand: CommandRunner;
}): Promise<string> {
  const repository = options.config.verifier.expectedRepository;
  const ref = options.config.verifier.expectedRef;
  const candidates = ref.startsWith('refs/tags/') ? [ref, `${ref}^{}`] : [ref];
  const result = await options.runCommand('git', ['ls-remote', '--exit-code', repository, ...candidates], {
    timeoutMs: options.config.verifier.freshnessTimeoutSeconds * 1_000,
    rejectOnNonZero: false,
    env: buildUntrustedEnv(process.env, options.config.safety.envAllowlist)
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not resolve trusted verifier revision ${repository} ${ref}: ${result.stderr || result.stdout || `git exited with code ${result.exitCode}`}`);
  }
  const resolved = result.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/, 2) as [string, string])
    .filter(([, candidateRef]) => candidates.includes(candidateRef));
  const exact = resolved.filter(([, candidateRef]) => candidateRef === ref);
  const peeled = resolved.filter(([, candidateRef]) => candidateRef === `${ref}^{}`);
  if (
    exact.length !== 1 ||
    peeled.length > 1 ||
    [...exact, ...peeled].some(([commit]) => !/^[0-9a-f]{40}$/i.test(commit))
  ) {
    throw new Error(`Trusted verifier revision ${repository} ${ref} did not resolve to one exact 40-character commit.`);
  }
  const commit = (peeled[0] ?? exact[0])[0];
  return commit.toLowerCase();
}
