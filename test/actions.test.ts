import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeProviderResult, prepareActionsFix, publishActionsFix, verifyActionsFix } from '../src/commands/actions.js';
import { defaultConfigYaml, loadConfig } from '../src/config/config.js';
import { runCommand, type CommandResult, type CommandRunner } from '../src/utils/command.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { parse, stringify } from 'yaml';
import { trustedRunner } from './helpers/trustedRunner.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('GitHub Actions fix workflow', () => {
  it('prepares an authorized provider prompt without a local registry', async () => {
    const cwd = await configuredRepo();
    const config = parse(defaultConfigYaml({ agent: 'codex', setup: null, verify: ['npm test'] }));
    config.issues.selection.mode = 'opt-in';
    await fs.writeFile(path.join(cwd, '.kaizen', 'config.yml'), stringify(config));
    const calls: string[] = [];
    const fakeRun: CommandRunner = vi.fn(async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (args[0] === 'repo') return result(command, args, 'owner/repo\n');
      if (args[0] === 'issue') {
        return result(command, args, JSON.stringify(issue(['kaizen', 'kaizen:ready', 'kaizen:authorized'])));
      }
      if (args.at(-1)?.endsWith('/events')) {
        return result(command, args, JSON.stringify([[{ id: 1, event: 'labeled', actor: { login: 'maintainer' }, label: { name: 'kaizen:authorized' }, created_at: '2026-07-16T00:00:00Z' }]]));
      }
      if (args.at(-1)?.endsWith('/permission')) return result(command, args, JSON.stringify({ permission: 'write' }));
      if (command === 'verifier' && args.join(' ') === '--version --json') {
        const commit = 'cca74b39287dbcaf74687ae4cacaeebfb3167c6e';
        return result(command, args, JSON.stringify({
          name: 'verifier', version: '0.0.0', status: 'current', stale: false,
          build: { commit, builtAt: '2026-08-03T00:00:00.000Z', dirty: false },
          runtime: { commit, dirty: false, packageRoot: '/runtime/verifier/packages/core' }
        }));
      }
      if (command === 'git' && args[0] === 'rev-parse') return result(command, args, `${'a'.repeat(40)}\n`);
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const outputDir = path.join(cwd, 'prepared');
    const prepared = await prepareActionsFix({ cwd, issue: 199, outputDir, runCommand: trustedRunner(fakeRun) });

    expect(prepared).toMatchObject({ repo: 'owner/repo', issue: 199, baseSha: 'a'.repeat(40) });
    const prompt = await fs.readFile(path.join(outputDir, 'prompt.md'), 'utf8');
    const context = JSON.parse(await fs.readFile(path.join(outputDir, 'context.json'), 'utf8'));
    expect(prompt).toContain('# Issue #199: Add Actions workflow');
    expect(prompt).toContain('Do not run repository setup or verification commands in this provider job');
    expect(prompt).toContain('Kaizen Loop will run every configured command');
    expect(prompt).toContain('the verification job fails closed if any command fails');
    expect(prompt).not.toContain('returns any failure for a repair attempt');
    expect(prompt).not.toContain('npm test');
    expect(context).toMatchObject({
      repo: 'owner/repo',
      issue: { number: 199, title: 'Add Actions workflow' },
      authorization: { authorized: true, actor: 'maintainer', permission: 'write' }
    });
    expect(calls.some((call) => call.includes('collaborators/maintainer/permission'))).toBe(true);
    expect(calls).toContain('verifier --version --json');
    expect(calls.some((call) => call.startsWith('git ls-remote '))).toBe(false);
    await expect(fs.access(path.join(cwd, '.kaizen', 'registry.json'))).rejects.toThrow();
  });

  it('fails closed when the authorization label is absent', async () => {
    const cwd = await configuredRepo();
    const fakeRun: CommandRunner = async (command, args) => {
      if (args[0] === 'repo') return result(command, args, 'owner/repo\n');
      if (args[0] === 'issue') return result(command, args, JSON.stringify(issue(['kaizen', 'kaizen:ready'])));
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    };

    await expect(prepareActionsFix({ cwd, issue: 199, outputDir: path.join(cwd, 'out'), runCommand: trustedRunner(fakeRun) }))
      .rejects.toThrow('Missing execution authorization label');
  });

  it('fails closed when the Kaizen eligibility label is absent', async () => {
    const cwd = await configuredRepo();
    const fakeRun: CommandRunner = async (command, args) => {
      if (args[0] === 'repo') return result(command, args, 'owner/repo\n');
      if (args[0] === 'issue') return result(command, args, JSON.stringify(issue(['kaizen:authorized'])));
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    };

    await expect(prepareActionsFix({ cwd, issue: 199, outputDir: path.join(cwd, 'out'), runCommand: trustedRunner(fakeRun) }))
      .rejects.toThrow('Missing Kaizen eligibility label');
  });

  it('fails closed when the configured selection label is absent in every selection mode', async () => {
    for (const mode of ['auto', 'manual-only', 'opt-in']) {
      const cwd = await configuredRepo();
      const config = parse(await fs.readFile(path.join(cwd, '.kaizen', 'config.yml'), 'utf8'));
      config.issues.selection.mode = mode;
      await fs.writeFile(path.join(cwd, '.kaizen', 'config.yml'), stringify(config));
      const fakeRun: CommandRunner = async (command, args) => {
        if (args[0] === 'repo') return result(command, args, 'owner/repo\n');
        if (args[0] === 'issue') {
          return result(command, args, JSON.stringify(issue(['kaizen', 'kaizen:authorized'])));
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      };

      await expect(prepareActionsFix({ cwd, issue: 199, outputDir: path.join(cwd, 'out'), runCommand: trustedRunner(fakeRun) }))
        .rejects.toThrow('Missing execution selection label: kaizen:ready');
    }
  });

  it('encodes provider output with a versioned provider identity', () => {
    expect(JSON.parse(encodeProviderResult('codex', '{"status":"fixed"}'))).toEqual({
      provider: 'codex',
      finalMessage: '{"status":"fixed"}',
      attempts: []
    });
  });

  it('refuses to publish when the patch hash differs from the verified manifest', async () => {
    const cwd = await configuredRepo();
    const artifactDir = path.join(cwd, 'artifact');
    await fs.mkdir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'change.patch'), 'tampered');
    await fs.writeFile(path.join(artifactDir, 'manifest.json'), JSON.stringify({
      version: 1,
      repo: 'owner/repo',
      issue: { number: 199, title: 'Add Actions workflow' },
      baseSha: 'a'.repeat(40),
      patchSha256: '0'.repeat(64),
      provider: 'codex',
      providerAttempts: [{ provider: 'codex', status: 'selected', failureClass: 'none' }],
      builder: { summary: 'summary', notes: '' },
      verification: [],
      verifier: { status: 'open_pr', summary: 'ok', notes: '' },
      files: ['README.md'],
      createdAt: new Date().toISOString()
    }));
    const command = vi.fn<CommandRunner>();

    await expect(publishActionsFix({ cwd, artifactDir, runCommand: trustedRunner(command) })).rejects.toThrow('patch hash');
    expect(command).not.toHaveBeenCalled();
  });

  it('refuses to publish when the default branch advanced after verification', async () => {
    const cwd = await configuredRepo();
    await fs.writeFile(path.join(cwd, 'README.md'), 'before\n');
    await runCommand('git', ['init', '-b', 'main'], { cwd });
    await runCommand('git', ['add', '.'], { cwd });
    await runCommand('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], { cwd });
    const baseSha = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    await fs.writeFile(path.join(cwd, 'README.md'), 'after\n');
    const patch = (await runCommand('git', ['diff', '--binary', 'HEAD'], { cwd })).stdout;
    await runCommand('git', ['reset', '--hard', 'HEAD'], { cwd });
    const artifactDir = path.join(cwd, 'artifact');
    await fs.mkdir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'change.patch'), patch);
    await fs.writeFile(path.join(artifactDir, 'manifest.json'), JSON.stringify({
      version: 1,
      repo: 'owner/repo',
      issue: { number: 199, title: 'Add Actions workflow' },
      baseSha,
      patchSha256: crypto.createHash('sha256').update(patch).digest('hex'),
      provider: 'codex',
      providerAttempts: [{ provider: 'codex', status: 'selected', failureClass: 'none' }],
      builder: { summary: 'Update README', notes: '' },
      verification: [],
      verifier: { status: 'open_pr', summary: 'ok', notes: '' },
      files: ['README.md'],
      createdAt: new Date().toISOString()
    }));
    const fakeRun: CommandRunner = async (command, args, options) => {
      if (command === 'gh' && args[0] === 'repo') return result(command, args, 'owner/repo\n');
      if (command === 'gh' && args[0] === 'issue') return result(command, args, JSON.stringify(issue(['kaizen', 'kaizen:ready', 'kaizen:authorized'])));
      if (command === 'gh' && args.at(-1)?.endsWith('/events')) {
        return result(command, args, JSON.stringify([[{ id: 1, event: 'labeled', actor: { login: 'maintainer' }, label: { name: 'kaizen:authorized' }, created_at: '2026-07-16T00:00:00Z' }]]));
      }
      if (command === 'gh' && args.at(-1)?.endsWith('/permission')) return result(command, args, JSON.stringify({ permission: 'write' }));
      if (command === 'gh' && args[0] === 'api' && args[1] === 'repos/owner/repo/git/ref/heads/main') {
        return result(command, args, `${'b'.repeat(40)}\n`);
      }
      return runCommand(command, args, options);
    };

    await expect(publishActionsFix({ cwd, artifactDir, runCommand: trustedRunner(fakeRun) }))
      .rejects.toThrow('Default branch advanced from verified base');
    expect((await fs.readFile(path.join(cwd, 'README.md'), 'utf8'))).toBe('before\n');
  });

  it('collects staged patch changes against the ephemeral checkout', async () => {
    const cwd = await configuredRepo();
    await runCommand('git', ['init'], { cwd });
    await runCommand('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'add', '.'], { cwd });
    await runCommand('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], { cwd });
    await fs.writeFile(path.join(cwd, 'feature.txt'), 'new\n');
    await runCommand('git', ['add', 'feature.txt'], { cwd });

    const stats = await new WorkspaceManager(runCommand, cwd).collectWorkingTreeDiffStats(await loadConfig(cwd));
    expect(stats.files).toEqual(['feature.txt']);
    expect(stats.changedLines).toBe(1);
  });

  it('rejects forbidden patch paths before repository setup runs', async () => {
    const cwd = await configuredRepo();
    await fs.writeFile(
      path.join(cwd, '.kaizen', 'config.yml'),
      defaultConfigYaml({ agent: 'codex', setup: 'touch setup-ran', verify: [] })
    );
    await fs.writeFile(path.join(cwd, 'README.md'), 'base\n');
    await runCommand('git', ['init', '-b', 'main'], { cwd });
    await runCommand('git', ['add', '.'], { cwd });
    await runCommand('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], { cwd });
    const baseSha = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    await fs.writeFile(path.join(cwd, 'secret.pem'), 'secret\n');
    await runCommand('git', ['add', '-N', 'secret.pem'], { cwd });
    const patch = (await runCommand('git', ['diff', '--binary', 'HEAD'], { cwd })).stdout;
    await runCommand('git', ['reset', '--', 'secret.pem'], { cwd });
    await fs.rm(path.join(cwd, 'secret.pem'));
    const patchPath = path.join(cwd, 'change.patch');
    const providerPath = path.join(cwd, 'provider.json');
    const contextPath = await writePreparedContext(cwd, baseSha);
    await fs.writeFile(patchPath, patch);
    await fs.writeFile(providerPath, encodeProviderResult('codex', JSON.stringify({
      status: 'fixed', summary: 'Add secret', notes: '', discoveredIssues: []
    })));
    const fakeRun: CommandRunner = async (command, args, options) => {
      if (command === 'gh' && args[0] === 'repo') return result(command, args, 'owner/repo\n');
      if (command === 'gh' && args[0] === 'issue') return result(command, args, JSON.stringify(issue(['kaizen', 'kaizen:ready', 'kaizen:authorized'])));
      if (command === 'gh' && args.at(-1)?.endsWith('/events')) {
        return result(command, args, JSON.stringify([[{ id: 1, event: 'labeled', actor: { login: 'maintainer' }, label: { name: 'kaizen:authorized' }, created_at: '2026-07-16T00:00:00Z' }]]));
      }
      if (command === 'gh' && args.at(-1)?.endsWith('/permission')) return result(command, args, JSON.stringify({ permission: 'write' }));
      return runCommand(command, args, options);
    };

    await expect(verifyActionsFix({
      cwd,
      issue: 199,
      patchPath,
      providerResultPath: providerPath,
      contextPath,
      outputDir: path.join(cwd, 'verified'),
      runCommand: trustedRunner(fakeRun)
    })).rejects.toThrow('Patch changes forbidden paths: secret.pem');
    await expect(fs.access(path.join(cwd, 'setup-ran'))).rejects.toThrow();
  });

  it('rejects a custom verifier trust root in the reusable Actions path', async () => {
    const cwd = await configuredRepo();
    const config = parse(await fs.readFile(path.join(cwd, '.kaizen', 'config.yml'), 'utf8'));
    config.verifier = {
      ...config.verifier,
      expectedRepository: 'https://github.com/example/custom-verifier.git',
      expectedRef: 'refs/heads/release'
    };
    await fs.writeFile(path.join(cwd, '.kaizen', 'config.yml'), stringify(config));
    const contextPath = await writePreparedContext(cwd, 'a'.repeat(40));
    const fakeRun: CommandRunner = async (command, args) => {
      if (command === 'gh' && args[0] === 'repo') return result(command, args, 'owner/repo\n');
      if (command === 'gh' && args[0] === 'issue') {
        return result(command, args, JSON.stringify(issue(['kaizen', 'kaizen:ready', 'kaizen:authorized'])));
      }
      if (command === 'gh' && args.at(-1)?.endsWith('/events')) {
        return result(command, args, JSON.stringify([[
          { id: 1, event: 'labeled', actor: { login: 'maintainer' }, label: { name: 'kaizen:authorized' }, created_at: '2026-07-16T00:00:00Z' }
        ]]));
      }
      if (command === 'gh' && args.at(-1)?.endsWith('/permission')) {
        return result(command, args, JSON.stringify({ permission: 'write' }));
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    };

    await expect(verifyActionsFix({
      cwd,
      issue: 199,
      patchPath: path.join(cwd, 'unused.patch'),
      providerResultPath: path.join(cwd, 'unused-provider.json'),
      contextPath,
      outputDir: path.join(cwd, 'verified'),
      runCommand: trustedRunner(fakeRun)
    })).rejects.toThrow('custom verifier trust roots require a corresponding trusted workflow checkout');
  });

  it('rejects a prepared context for a different issue before running commands', async () => {
    const cwd = await configuredRepo();
    const contextPath = await writePreparedContext(cwd, 'a'.repeat(40), 200);
    const command = vi.fn<CommandRunner>();

    await expect(verifyActionsFix({
      cwd,
      issue: 199,
      patchPath: path.join(cwd, 'unused.patch'),
      providerResultPath: path.join(cwd, 'unused-provider.json'),
      contextPath,
      outputDir: path.join(cwd, 'verified'),
      runCommand: trustedRunner(command)
    })).rejects.toThrow('Prepared issue #200 does not match requested issue #199');
    expect(command).not.toHaveBeenCalled();
  });

  it('verifies and publishes the exact authorized patch without executing publish hooks', async () => {
    const cwd = await configuredRepo();
    await fs.writeFile(path.join(cwd, 'README.md'), 'before\n');
    await runCommand('git', ['init', '-b', 'main'], { cwd });
    await runCommand('git', ['add', '.'], { cwd });
    await runCommand('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], { cwd });
    const baseSha = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    await fs.writeFile(path.join(cwd, 'README.md'), 'after\n');
    const patch = (await runCommand('git', ['diff', '--binary', 'HEAD'], { cwd })).stdout;
    await runCommand('git', ['reset', '--hard', 'HEAD'], { cwd });
    const patchPath = path.join(cwd, 'change.patch');
    const providerPath = path.join(cwd, 'provider.json');
    const artifactDir = path.join(cwd, 'verified');
    const contextPath = await writePreparedContext(cwd, baseSha);
    await fs.writeFile(patchPath, patch);
    await fs.writeFile(providerPath, encodeProviderResult('codex', JSON.stringify({
      status: 'fixed', summary: 'Update README', notes: '', discoveredIssues: []
    })));
    let authorizationChecks = 0;
    let liveBaseChecks = 0;
    let verifierFreshnessChecks = 0;
    let allowGithub = false;
    const fakeRun: CommandRunner = async (command, args, options) => {
      if (command === 'gh' && !allowGithub) throw new Error('verify must not invoke GitHub');
      if (command === 'gh' && args[0] === 'repo' && args.includes('nameWithOwner')) return result(command, args, 'owner/repo\n');
      if (command === 'gh' && args[0] === 'repo') return result(command, args, JSON.stringify({ defaultBranchRef: { name: 'main' } }));
      if (command === 'gh' && args[0] === 'issue') return result(command, args, JSON.stringify(issue(['kaizen', 'kaizen:ready', 'kaizen:authorized'])));
      if (command === 'gh' && args.at(-1)?.endsWith('/events')) {
        authorizationChecks += 1;
        return result(command, args, JSON.stringify([[{ id: 1, event: 'labeled', actor: { login: 'maintainer' }, label: { name: 'kaizen:authorized' }, created_at: '2026-07-16T00:00:00Z' }]]));
      }
      if (command === 'gh' && args.at(-1)?.endsWith('/permission')) return result(command, args, JSON.stringify({ permission: 'write' }));
      if (command === 'gh' && args[0] === 'api' && args[1] === 'repos/owner/repo/git/ref/heads/main') {
        liveBaseChecks += 1;
        return result(command, args, `${baseSha}\n`);
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return result(command, args, 'https://github.com/owner/repo/pull/7\n');
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return result(command, args, JSON.stringify({
          number: 7, url: 'https://github.com/owner/repo/pull/7', baseRefName: 'main', isDraft: false,
          closingIssuesReferences: [{ number: 199 }]
        }));
      }
      if (command === 'verifier' && args.join(' ') === '--version --json') {
        verifierFreshnessChecks += 1;
        const commit = 'cca74b39287dbcaf74687ae4cacaeebfb3167c6e';
        return result(command, args, JSON.stringify({
          name: 'verifier', version: '0.0.0', status: 'current', stale: false,
          build: { commit, builtAt: '2026-08-03T00:00:00.000Z', dirty: false },
          runtime: { commit, dirty: false, packageRoot: '/runtime/verifier/packages/core' }
        }));
      }
      if (command === 'verifier' && args[0] === '--version') return result(command, args, 'verifier 1\n');
      if (command === 'verifier') {
        await fs.mkdir(path.dirname(options!.env!.KAIZEN_VERIFIER_RESULT_PATH!), { recursive: true });
        await fs.writeFile(options!.env!.KAIZEN_VERIFIER_RESULT_PATH!, JSON.stringify({
          status: 'open_pr', summary: 'verified', notes: '', evidence_grade: 'executed'
        }));
        return result(command, args, '');
      }
      if (command === 'git' && ['remote get-url origin', 'remote get-url --push --all origin'].includes(args.join(' '))) {
        return result(command, args, 'https://github.com/owner/repo.git\n');
      }
      if (command === 'git' && args[0] === 'push') return result(command, args, '');
      return runCommand(command, args, options);
    };

    const artifact = await verifyActionsFix({
      cwd,
      issue: 199,
      patchPath,
      providerResultPath: providerPath,
      contextPath,
      outputDir: artifactDir,
      runCommand: trustedRunner(fakeRun)
    });
    expect(artifact.baseSha).toBe(baseSha);
    expect(artifact.files).toEqual(['README.md']);
    expect(authorizationChecks).toBe(0);
    await runCommand('git', ['reset', '--hard', 'HEAD'], { cwd });

    allowGithub = true;
    vi.stubEnv('GH_TOKEN', 'publication-token');
    const published = await publishActionsFix({ cwd, artifactDir, runCommand: trustedRunner(fakeRun) });
    expect(published.url).toBe('https://github.com/owner/repo/pull/7');
    expect(published.body).toContain('Closes #199');
    expect(authorizationChecks).toBe(1);
    expect(liveBaseChecks).toBe(1);
    expect(verifierFreshnessChecks).toBe(1);
    expect((await runCommand('git', ['show', 'HEAD:README.md'], { cwd })).stdout).toBe('after\n');
  });

  it('keeps provider, verification, and publish credentials in separate workflow jobs', async () => {
    const workflowPath = path.resolve('.github/workflows/kaizen-fix-reusable.yml');
    const raw = await fs.readFile(workflowPath, 'utf8');
    const workflow = parse(raw) as { jobs: Record<string, { permissions?: Record<string, string>; steps: Array<Record<string, unknown>> }> };

    expect(workflow.jobs.codex.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.claude.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.verify.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.publish.permissions).toEqual({ contents: 'write', issues: 'read', 'pull-requests': 'write' });
    expect(raw).toContain('openai/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56');
    expect(raw).toContain('anthropics/claude-code-action@273fe825408ddced56cb02b228a74c72bed8241e');
    expect(raw).toContain(
      'repository: kaizen-agents-org/verifier\n          ref: cca74b39287dbcaf74687ae4cacaeebfb3167c6e'
    );
    const prepareJob = JSON.stringify(workflow.jobs.prepare);
    expect(prepareJob).toContain('kaizen-agents-org/verifier');
    expect(prepareJob).toContain('cca74b39287dbcaf74687ae4cacaeebfb3167c6e');
    expect(prepareJob).toContain('kaizen-bin/verifier');
    expect(prepareJob).toContain('RUNNER_TEMP/kaizen-bin');
    expect(workflow.jobs.provider_gate).toBeDefined();
    expect(raw).not.toContain('Fail Codex attempt without a patch');
    expect(raw).not.toContain('Fail Claude attempt without a patch');
    expect(JSON.stringify(workflow.jobs.verify)).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY/);
    expect(JSON.stringify(workflow.jobs.verify)).toContain('kaizen-provider-prompt');
    expect(JSON.stringify(workflow.jobs.verify)).toContain('--actions-context');
    expect(JSON.stringify(workflow.jobs.publish)).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  });
});

async function configuredRepo(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-actions-test-'));
  tempDirs.push(cwd);
  await fs.mkdir(path.join(cwd, '.kaizen'));
  await fs.writeFile(path.join(cwd, '.kaizen', 'config.yml'), defaultConfigYaml({ agent: 'codex', setup: null, verify: [] }));
  return cwd;
}

async function writePreparedContext(cwd: string, baseSha: string, issueNumber = 199): Promise<string> {
  const contextPath = path.join(cwd, `prepared-${baseSha.slice(0, 8)}.json`);
  await fs.writeFile(contextPath, JSON.stringify({
    version: 1,
    repo: 'owner/repo',
    issue: { ...issue(['kaizen', 'kaizen:ready', 'kaizen:authorized']), number: issueNumber },
    baseSha,
    authorization: {
      authorized: true,
      actor: 'maintainer',
      permission: 'write',
      reason: 'authorized by maintainer (write)'
    }
  }));
  return contextPath;
}

function issue(labels: string[]) {
  return {
    number: 199,
    title: 'Add Actions workflow',
    body: 'Implement it.',
    labels: labels.map((name) => ({ name })),
    createdAt: new Date().toISOString(),
    comments: []
  };
}

function result(command: string, args: string[], stdout: string): CommandResult {
  return { command, args, exitCode: 0, stdout, stderr: '', durationMs: 1 };
}
