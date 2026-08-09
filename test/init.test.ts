import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { createInitialConfig, initProject, readInstalledVerifierRef } from '../src/init/init.js';
import { mergeOverlay } from '../src/init/profile.js';
import type { CommandRunner } from '../src/utils/command.js';
import { trustedRunner } from './helpers/trustedRunner.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('initProject', () => {
  it('seeds generated config from the pinned Verifier install stamp', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-init-home-'));
    const stamp = path.join(home, 'toolchain', 'verifier', '.installed-version');
    await fs.mkdir(path.dirname(stamp), { recursive: true });
    await fs.writeFile(stamp, 'v0.1.0\n');

    const config = configSchema.parse(await createInitialConfig({
      agent: 'codex',
      setup: null,
      verify: []
    }, home));

    expect(config.verifier.expectedRef).toBe('refs/tags/v0.1.0');
  });

  it('lets an explicit profile ref override the installed release pin', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-init-home-'));
    const stamp = path.join(home, 'toolchain', 'verifier', '.installed-version');
    await fs.mkdir(path.dirname(stamp), { recursive: true });
    await fs.writeFile(stamp, 'v0.1.0\n');
    const seeded = await createInitialConfig({ agent: 'codex', setup: null, verify: [] }, home);

    const config = configSchema.parse(mergeOverlay(seeded, {
      verifier: { expectedRef: 'refs/heads/release' }
    }));

    expect(config.verifier.expectedRef).toBe('refs/heads/release');
  });

  it('preserves the main default when no Verifier install stamp exists', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-init-home-'));

    expect(await readInstalledVerifierRef(home)).toBeUndefined();
  });

  it.each(['v1.0.0', 'v0.01.0', 'v0.1.0\nv0.2.0', 'main'])('rejects invalid Verifier install stamp %j', async (version) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-init-home-'));
    const stamp = path.join(home, 'toolchain', 'verifier', '.installed-version');
    await fs.mkdir(path.dirname(stamp), { recursive: true });
    await fs.writeFile(stamp, version);

    await expect(readInstalledVerifierRef(home)).rejects.toThrow('expected one v0.x.y release tag');
  });

  it('does not hide install stamp read failures', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-init-home-'));
    const stamp = path.join(home, 'toolchain', 'verifier', '.installed-version');
    await fs.mkdir(stamp, { recursive: true });

    await expect(readInstalledVerifierRef(home)).rejects.toThrow('Unable to read installed Verifier version');
  });

  it('requires publication auth before writing project state', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-init-'));
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    const runner = vi.fn<CommandRunner>(async (command, args) => ({
      command,
      args,
      cwd: repo,
      exitCode: 0,
      stdout: args.join(' ') === 'rev-parse --show-toplevel'
        ? `${repo}\n`
        : args.join(' ') === 'remote get-url origin'
          ? 'https://github.com/o/r.git\n'
          : '',
      stderr: '',
      durationMs: 1
    }));

    const error = await initProject({
      cwd: repo,
      schedule: '02:00',
      yes: false,
      runCommand: trustedRunner(runner)
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ exitCode: 2 });
    expect(String(error)).toContain('GH_TOKEN or GITHUB_TOKEN');
    await expect(fs.access(path.join(repo, '.kaizen', 'config.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runner.mock.calls.some(([command, args]) => command === 'gh' && args[0] === 'label')).toBe(false);
  });
});
