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
    await fs.writeFile(path.join(runtime, '.kaizen-built-commit'), 'runtime-commit\n');
    await writeExecutable(path.join(bin, 'git'), `#!/bin/sh
case "$*" in
  *"rev-parse --show-toplevel"*) exit 1 ;;
  *"rev-parse HEAD"*) printf '%s\\n' runtime-commit ;;
  *) exit 0 ;;
esac
`);
    await writeExecutable(path.join(bin, 'node'), `#!/bin/sh
printf '%s\\n' "$KAIZEN_RUNTIME_COMMIT" "$@" > "$KAIZEN_TEST_INVOCATION"
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

    await execFileAsync('/bin/sh', [path.join(home, 'bin', 'kaizen'), 'doctor', '--json'], { env });
    expect((await fs.readFile(invocationPath, 'utf8')).trim().split('\n')).toEqual([
      'runtime-commit',
      path.join(runtime, 'dist', 'cli.js'),
      'doctor',
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
});

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content);
  await fs.chmod(filePath, 0o755);
}
