import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.join(import.meta.dirname, '..');

/**
 * The onboarding installer clones a pinned tag, builds it, and links the CLI,
 * rather than going through `npm install -g`. npm sets the executable bit on a
 * package `bin` during a global install; a clone-and-build install does not, so
 * `dist/cli.js` has to carry the bit itself or the linked `kaizen` command
 * fails with "permission denied".
 */
describe('dist/cli.js executable bit', () => {
  it('is committed as executable', async () => {
    const { stdout } = await execFileAsync('git', ['ls-files', '-s', 'dist/cli.js'], {
      cwd: repoRoot
    });
    const mode = stdout.trim().split(/\s+/)[0];
    expect(mode, 'dist/cli.js must be committed with mode 100755').toBe('100755');
  });

  it('is executable on disk after a build', async () => {
    const stat = await fs.stat(path.join(repoRoot, 'dist', 'cli.js'));
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o111, 'dist/cli.js must have an executable bit set').not.toBe(0);
  });

  it('is chmodded by the build script, not left to the installer', async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.build ?? '').toMatch(/chmod/i);
  });
});
