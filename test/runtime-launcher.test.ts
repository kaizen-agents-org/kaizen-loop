import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('stable Kaizen runtime launcher', () => {
  it('bypasses a stale global kaizen for operator and scheduled commands', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-runtime-launcher-'));
    const home = path.join(root, 'home');
    const runtime = path.join(home, 'runtime', 'kaizen-loop');
    const bin = path.join(root, 'fake-bin');
    const invocationPath = path.join(root, 'invocation');
    const staleInvocationPath = path.join(root, 'stale-invocation');
    await fs.mkdir(path.join(home, 'bin'), { recursive: true });
    await fs.mkdir(path.join(runtime, '.git'), { recursive: true });
    await fs.mkdir(path.join(runtime, 'dist'), { recursive: true });
    await fs.mkdir(path.join(runtime, 'scripts'), { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.copyFile('scripts/kaizen-runtime.sh', path.join(home, 'bin', 'kaizen'));
    await fs.copyFile('scripts/run-scheduled.sh', path.join(home, 'bin', 'run-scheduled.sh'));
    await fs.chmod(path.join(home, 'bin', 'kaizen'), 0o755);
    await fs.chmod(path.join(home, 'bin', 'run-scheduled.sh'), 0o755);
    await fs.copyFile('scripts/kaizen-runtime.sh', path.join(runtime, 'scripts', 'kaizen-runtime.sh'));
    await fs.copyFile('scripts/run-scheduled.sh', path.join(runtime, 'scripts', 'run-scheduled.sh'));
    await fs.writeFile(path.join(runtime, 'dist', 'cli.js'), '');
    await fs.writeFile(path.join(runtime, '.kaizen-built-commit'), 'stale-runtime-commit\n');
    await writeExecutable(path.join(bin, 'git'), `#!/bin/sh
case "$*" in
  *"rev-parse --show-toplevel"*) exit 1 ;;
  *"rev-parse HEAD"*) printf '%s\\n' runtime-commit ;;
  *) exit 0 ;;
esac
`);
    await writeExecutable(path.join(bin, 'node'), `#!/bin/sh
printf '%s\\n' "$KAIZEN_RUNTIME_COMMIT" "$@" > "$KAIZEN_TEST_INVOCATION"
case " $* " in
  *" --json "*) printf '{"ok":true}\\n' ;;
esac
`);
    await writeExecutable(path.join(bin, 'npm'), `#!/bin/sh
printf 'npm %s\\n' "$*"
`);
    await writeExecutable(path.join(bin, 'kaizen'), `#!/bin/sh
printf '%s\\n' stale > "$KAIZEN_TEST_STALE_INVOCATION"
exit 99
`);
    const env = {
      ...process.env,
      HOME: home,
      KAIZEN_HOME: home,
      KAIZEN_RUNTIME_REMOTE: 'unused',
      KAIZEN_TEST_INVOCATION: invocationPath,
      KAIZEN_TEST_STALE_INVOCATION: staleInvocationPath,
      PATH: `${bin}:${process.env.PATH ?? ''}`
    };

    const firstRun = await execFileAsync(
      '/bin/sh',
      [path.join(home, 'bin', 'kaizen'), 'doctor', '--json'],
      { env }
    );
    expect(firstRun.stdout).toBe('{"ok":true}\n');
    // dist/ ships with the commit, so a refresh installs runtime dependencies
    // and skips the build; only a commit without dist/ needs to build.
    expect(firstRun.stderr).toContain('npm ci');
    expect(firstRun.stderr).not.toContain('npm run build');
    expect((await fs.readFile(invocationPath, 'utf8')).trim().split('\n')).toEqual([
      'runtime-commit',
      path.join(runtime, 'dist', 'cli.js'),
      'doctor',
      '--json'
    ]);
    await expect(fs.access(staleInvocationPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const manifestPath = path.join(home, 'fleet.yml');
    await execFileAsync('/bin/sh', [
      path.join(home, 'bin', 'kaizen'),
      'fleet',
      '--manifest',
      manifestPath,
      '--dry-run',
      '--json'
    ], { env });
    expect((await fs.readFile(invocationPath, 'utf8')).trim().split('\n')).toEqual([
      'runtime-commit',
      path.join(runtime, 'dist', 'cli.js'),
      'fleet',
      '--manifest',
      manifestPath,
      '--dry-run',
      '--json'
    ]);
    await expect(fs.access(staleInvocationPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.rm(path.join(home, 'bin', 'kaizen'));
    await execFileAsync('/bin/sh', [path.join(home, 'bin', 'run-scheduled.sh'), path.join(bin, 'node'), 'owner-repo', 'maintenance'], { env });
    expect((await fs.readFile(invocationPath, 'utf8')).trim().split('\n')).toEqual([
      'runtime-commit',
      path.join(runtime, 'dist', 'cli.js'),
      'run',
      '--project',
      'owner-repo',
      '--scheduled',
      '--job',
      'maintenance'
    ]);
    await expect(fs.access(path.join(home, 'bin', 'kaizen'))).resolves.toBeUndefined();
    await expect(fs.access(staleInvocationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    {
      name: 'follows the main branch by default so dogfood repositories stay on unreleased code',
      ref: undefined,
      expectFetch: 'fetch --prune origin +refs/heads/main:refs/remotes/origin/main',
      expectUpdate: 'reset --hard refs/remotes/origin/main'
    },
    {
      name: 'pins to a release tag when KAIZEN_RUNTIME_REF names one',
      ref: 'v0.1.0',
      expectFetch: 'fetch --prune origin refs/tags/v0.1.0:refs/tags/v0.1.0',
      expectUpdate: 'reset --hard refs/tags/v0.1.0'
    }
  ])('$name', async ({ ref, expectFetch, expectUpdate }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-runtime-ref-'));
    const home = path.join(root, 'home');
    const runtime = path.join(home, 'runtime', 'kaizen-loop');
    const bin = path.join(root, 'fake-bin');
    const gitLog = path.join(root, 'git-log');
    await fs.mkdir(path.join(home, 'bin'), { recursive: true });
    await fs.mkdir(path.join(runtime, '.git'), { recursive: true });
    await fs.mkdir(path.join(runtime, 'dist'), { recursive: true });
    await fs.mkdir(path.join(runtime, 'scripts'), { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.copyFile('scripts/kaizen-runtime.sh', path.join(home, 'bin', 'kaizen'));
    await fs.chmod(path.join(home, 'bin', 'kaizen'), 0o755);
    await fs.copyFile('scripts/kaizen-runtime.sh', path.join(runtime, 'scripts', 'kaizen-runtime.sh'));
    await fs.writeFile(path.join(runtime, 'dist', 'cli.js'), '');
    await fs.writeFile(path.join(runtime, '.kaizen-built-commit'), 'pinned-commit\n');

    await writeExecutable(path.join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "$KAIZEN_TEST_GIT_LOG"
case "$*" in
  *"rev-parse --show-toplevel"*) exit 1 ;;
  *"rev-parse HEAD"*) printf '%s\\n' pinned-commit ;;
esac
exit 0
`);
    await writeExecutable(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      KAIZEN_HOME: home,
      KAIZEN_RUNTIME_REMOTE: 'https://example.invalid/kaizen-loop.git',
      KAIZEN_TEST_GIT_LOG: gitLog,
      PATH: `${bin}:${process.env.PATH ?? ''}`
    };
    if (ref) env.KAIZEN_RUNTIME_REF = ref;
    else delete env.KAIZEN_RUNTIME_REF;

    await execFileAsync('/bin/sh', [path.join(home, 'bin', 'kaizen'), 'doctor'], { env });

    const commands = await fs.readFile(gitLog, 'utf8');
    expect(commands).toContain(expectFetch);
    expect(commands).toContain(expectUpdate);

    if (ref) {
      // A pinned runtime must never resolve through a branch tip.
      expect(commands).not.toContain('origin/main');
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds when the checked-out commit does not carry dist', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-runtime-nodist-'));
    const home = path.join(root, 'home');
    const runtime = path.join(home, 'runtime', 'kaizen-loop');
    const bin = path.join(root, 'fake-bin');
    await fs.mkdir(path.join(home, 'bin'), { recursive: true });
    await fs.mkdir(path.join(runtime, '.git'), { recursive: true });
    await fs.mkdir(path.join(runtime, 'scripts'), { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.copyFile('scripts/kaizen-runtime.sh', path.join(home, 'bin', 'kaizen'));
    await fs.chmod(path.join(home, 'bin', 'kaizen'), 0o755);
    await fs.copyFile('scripts/kaizen-runtime.sh', path.join(runtime, 'scripts', 'kaizen-runtime.sh'));

    await writeExecutable(path.join(bin, 'git'), `#!/bin/sh
case "$*" in
  *"rev-parse --show-toplevel"*) exit 1 ;;
  *"rev-parse HEAD"*) printf '%s\\n' nodist-commit ;;
esac
exit 0
`);
    // Stand in for a real build by creating the CLI the launcher then execs.
    await writeExecutable(path.join(bin, 'npm'), `#!/bin/sh
printf 'npm %s\\n' "$*"
case "$*" in
  *"run build"*) mkdir -p "${runtime}/dist" && printf '' > "${runtime}/dist/cli.js" ;;
esac
`);
    await writeExecutable(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n');

    const env = {
      ...process.env,
      HOME: home,
      KAIZEN_HOME: home,
      KAIZEN_RUNTIME_REMOTE: 'https://example.invalid/kaizen-loop.git',
      PATH: `${bin}:${process.env.PATH ?? ''}`
    };

    const run = await execFileAsync('/bin/sh', [path.join(home, 'bin', 'kaizen'), 'doctor'], { env });
    expect(run.stderr).toContain('npm run build');
    await expect(fs.access(path.join(runtime, 'dist', 'cli.js'))).resolves.toBeUndefined();

    await fs.rm(root, { recursive: true, force: true });
  });
});

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content);
  await fs.chmod(filePath, 0o755);
}
