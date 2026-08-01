import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledProfilesDir } from '../src/init/profile.js';

/**
 * `.github/onboarding/profiles/` is the source of truth; `profiles/` here is a
 * vendored copy so `kaizen init` works offline. This check fails when the two
 * diverge.
 *
 * It is skipped when the `.github` checkout is not a sibling of this one, so
 * the suite still passes on a clean single-repository clone and in CI runners
 * that check out one repository.
 */
const sourceOfTruth = path.join(import.meta.dirname, '..', '..', '.github', 'onboarding', 'profiles');

async function digestProfiles(directory: string): Promise<Map<string, string>> {
  const entries = (await fs.readdir(directory)).filter((entry) => entry.endsWith('.yml')).sort();
  const digests = new Map<string, string>();
  for (const entry of entries) {
    const content = await fs.readFile(path.join(directory, entry));
    digests.set(entry, createHash('sha256').update(content).digest('hex'));
  }
  return digests;
}

async function exists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

describe('vendored onboarding profiles', () => {
  it('match the .github source of truth when it is checked out alongside', async ({ skip }) => {
    if (!(await exists(sourceOfTruth))) {
      skip('.github/onboarding/profiles is not checked out next to this repository');
      return;
    }

    const vendored = await digestProfiles(bundledProfilesDir());
    const authoritative = await digestProfiles(sourceOfTruth);

    expect(
      [...vendored.keys()],
      'vendored profile list must match .github/onboarding/profiles'
    ).toEqual([...authoritative.keys()]);

    for (const [name, digest] of authoritative) {
      expect(
        vendored.get(name),
        `profiles/${name} differs from .github/onboarding/profiles/${name}; re-vendor it`
      ).toBe(digest);
    }
  });
});
