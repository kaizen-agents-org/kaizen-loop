import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfigObject } from '../src/config/config.js';
import { configSchema } from '../src/config/schema.js';
import {
  SAFETY_FLOOR_PROTECTED_PATHS,
  applySafetyFloor,
  bundledProfilesDir,
  loadProfile,
  mergeOverlay,
  resolveProfilePath
} from '../src/init/profile.js';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-profile-'));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

async function writeProfile(name: string, body: string): Promise<string> {
  await fs.writeFile(path.join(workDir, `${name}.yml`), body, 'utf8');
  return workDir;
}

describe('resolveProfilePath', () => {
  it('resolves a bare name inside the profiles directory', () => {
    expect(resolveProfilePath('pilot-node', '/profiles')).toBe('/profiles/pilot-node.yml');
  });

  it('treats a value with a separator or yaml suffix as a caller path', () => {
    expect(resolveProfilePath('./custom.yml', '/profiles')).toBe(path.resolve('./custom.yml'));
  });

  it('rejects a bare name that is not a valid identifier', () => {
    expect(() => resolveProfilePath('bad name', '/profiles')).toThrow(/Invalid profile name/);
    expect(() => resolveProfilePath('semi;colon', '/profiles')).toThrow(/Invalid profile name/);
  });

  it('does not let a bare name traverse out of the profiles directory', () => {
    // A relative path is an explicit, supported way to name a profile file, so
    // it resolves as a path rather than being rejected. What must not happen is
    // a *bare name* escaping the directory.
    expect(resolveProfilePath('../escape', '/profiles')).toBe(path.resolve('../escape'));
    expect(resolveProfilePath('pilot-node', '/profiles').startsWith('/profiles/')).toBe(true);
  });
});

describe('loadProfile', () => {
  it('rejects a profile that sets a safety-floor invariant', async () => {
    const dir = await writeProfile('bad', 'policy:\n  mode: direct-only\n');
    await expect(loadProfile('bad', dir)).rejects.toThrow(/policy\.mode/);
  });

  it('rejects a profile that disables the verifier', async () => {
    const dir = await writeProfile('bad', 'verifier:\n  enabled: false\n');
    await expect(loadProfile('bad', dir)).rejects.toThrow(/verifier\.enabled/);
  });

  it('reports a missing profile with its resolved path', async () => {
    await expect(loadProfile('absent', workDir)).rejects.toThrow(/Profile not found/);
  });

  it('rejects a non-mapping profile', async () => {
    const dir = await writeProfile('scalar', 'just-a-string\n');
    await expect(loadProfile('scalar', dir)).rejects.toThrow(/must be a YAML mapping/);
  });
});

describe('mergeOverlay', () => {
  it('merges nested mappings key by key', () => {
    expect(mergeOverlay({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });

  it('replaces arrays wholesale instead of appending', () => {
    expect(mergeOverlay({ verify: ['a', 'b'] }, { verify: ['c'] })).toEqual({ verify: ['c'] });
  });
});

describe('applySafetyFloor', () => {
  it('restores protected paths a profile removed and reports the correction', () => {
    const { config, corrections } = applySafetyFloor({
      policy: { protectedPaths: ['docs/**'], forbiddenPaths: ['**/.git/**'] }
    });
    const policy = config.policy as { protectedPaths: string[] };
    for (const required of SAFETY_FLOOR_PROTECTED_PATHS) {
      expect(policy.protectedPaths).toContain(required);
    }
    expect(policy.protectedPaths).toContain('docs/**');
    expect(corrections.join(' ')).toMatch(/restored policy\.protectedPaths/);
  });

  it('caps a wip limit above the organization maximum', () => {
    const { config, corrections } = applySafetyFloor({ safety: { wipLimit: 50 } });
    expect((config.safety as { wipLimit: number }).wipLimit).toBe(5);
    expect(corrections.join(' ')).toMatch(/lowered safety\.wipLimit from 50 to 5/);
  });

  it('reports no corrections for a compliant config', () => {
    const base = defaultConfigObject({ agent: 'claude', setup: null, verify: [] });
    expect(applySafetyFloor(base).corrections).toEqual([]);
  });
});

describe('bundled profiles', () => {
  it('produces a schema-valid config that keeps the safety floor for every profile', async () => {
    const dir = bundledProfilesDir();
    const entries = (await fs.readdir(dir)).filter((entry) => entry.endsWith('.yml'));
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const overlay = await loadProfile(entry.replace(/\.yml$/, ''), dir);
      const base = defaultConfigObject({ agent: 'claude', setup: 'npm ci', verify: ['npm test'] });
      const merged = mergeOverlay(base, overlay.values) as Record<string, unknown>;
      const { config, corrections } = applySafetyFloor(merged);

      expect(corrections, `${entry} must not need safety-floor correction`).toEqual([]);
      const parsed = configSchema.parse(config);
      expect(parsed.policy.mode, `${entry} must stay pr-only`).toBe('pr-only');
      expect(parsed.verifier.enabled, `${entry} must keep the verifier enabled`).toBe(true);
      expect(parsed.safety.wipLimit).toBeLessThanOrEqual(5);
    }
  });
});
