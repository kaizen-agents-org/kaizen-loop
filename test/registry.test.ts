import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRegistry, resolveProject, saveRegistry, updateRegistry, upsertProject } from '../src/config/registry.js';
import type { RegistryProject } from '../src/config/schema.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registry', () => {
  it('round-trips registry data', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-reg-'));
    const file = path.join(dir, 'registry.json');

    await saveRegistry(
      {
        version: 1,
        projects: {
          'owner-repo': {
            repo: 'owner/repo',
            localPath: '/tmp/repo',
            workspacePath: '/tmp/workspace',
            schedule: '02:00',
            enabled: false,
            createdAt: '2026-06-12T00:00:00.000Z'
          }
        }
      },
      file
    );

    const loaded = await loadRegistry(file);
    expect(loaded.projects['owner-repo'].repo).toBe('owner/repo');
  });

  it('serializes concurrent read-modify-write updates without losing projects', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-reg-'));
    const file = path.join(dir, 'registry.json');

    await Promise.all(Array.from({ length: 12 }, (_, index) => updateRegistry((registry) => {
      registry.projects[`owner-repo-${index}`] = {
        ...project(),
        repo: `owner/repo-${index}`
      };
    }, file)));

    const loaded = await loadRegistry(file);
    expect(Object.keys(loaded.projects)).toHaveLength(12);
    await expect(fs.readdir(dir)).resolves.toEqual(['registry.json']);
  });

  it('recovers a registry lock left by a dead process', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-reg-'));
    const file = path.join(dir, 'registry.json');
    const lock = `${file}.lock`;
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() }));

    await saveRegistry({ version: 1, projects: {} }, file);

    await expect(loadRegistry(file)).resolves.toEqual({ version: 1, projects: {} });
    await expect(fs.access(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries when a contended registry lock disappears during inspection', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-reg-'));
    const file = path.join(dir, 'registry.json');
    const lock = `${file}.lock`;
    await fs.mkdir(lock);
    const originalStat = fs.stat.bind(fs);
    let intercepted = false;
    vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
      if (!intercepted && String(target) === lock) {
        intercepted = true;
        await fs.rm(lock, { recursive: true, force: true });
        throw Object.assign(new Error('lock disappeared'), { code: 'ENOENT' });
      }
      return originalStat(target);
    });

    await saveRegistry({ version: 1, projects: {} }, file);

    expect(intercepted).toBe(true);
    await expect(loadRegistry(file)).resolves.toEqual({ version: 1, projects: {} });
    await expect(fs.access(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove a young lock with partially written owner metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-reg-'));
    const file = path.join(dir, 'registry.json');
    const lock = `${file}.lock`;
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner.json'), '{');
    const originalRm = fs.rm.bind(fs);
    let holderReleased = false;
    let removedBeforeRelease = false;
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === lock && !holderReleased) removedBeforeRelease = true;
      return originalRm(target, options);
    });
    const release = setTimeout(() => {
      holderReleased = true;
      void originalRm(lock, { recursive: true, force: true });
    }, 100);

    try {
      await saveRegistry({ version: 1, projects: {} }, file);
    } finally {
      clearTimeout(release);
    }

    expect(removedBeforeRelease).toBe(false);
    await expect(loadRegistry(file)).resolves.toEqual({ version: 1, projects: {} });
  });

  it('allows only one contender to reap the same stale lock', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-reg-'));
    const file = path.join(dir, 'registry.json');
    const lock = `${file}.lock`;
    const reaper = path.join(lock, '.reaper');
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() }));

    const originalWriteFile = fs.writeFile.bind(fs);
    let releaseReaper: (() => void) | undefined;
    const reaperHeld = new Promise<void>((resolve) => {
      releaseReaper = resolve;
    });
    let firstReaperClaimed: (() => void) | undefined;
    const firstClaim = new Promise<void>((resolve) => {
      firstReaperClaimed = resolve;
    });
    let reaperAttempts = 0;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (target, data, options) => {
      const result = await originalWriteFile(target, data, options);
      if (String(target) === reaper) {
        reaperAttempts += 1;
        if (reaperAttempts === 1) {
          firstReaperClaimed?.();
          await reaperHeld;
        }
      }
      return result;
    });

    const first = updateRegistry((registry) => {
      registry.projects.first = { ...project(), repo: 'owner/first' };
    }, file);
    await firstClaim;
    const second = updateRegistry((registry) => {
      registry.projects.second = { ...project(), repo: 'owner/second' };
    }, file);
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseReaper?.();
    await Promise.all([first, second]);

    const loaded = await loadRegistry(file);
    expect(Object.keys(loaded.projects).sort()).toEqual(['first', 'second']);
    expect(reaperAttempts).toBe(1);
  });
});

describe('registry project slugs', () => {
  it('rejects unsafe slugs when loading registry data', async () => {
    const registryPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-registry-')), 'registry.json');
    await fs.writeFile(registryPath, JSON.stringify({
      version: 1,
      projects: {
        '../escape': project()
      }
    }));

    await expect(loadRegistry(registryPath)).rejects.toThrow(/Invalid registry/);
  });

  it('rejects unsafe slugs before inserting registry entries', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    vi.stubEnv('KAIZEN_HOME', home);

    await expect(upsertProject('owner/../escape', project())).rejects.toThrow('Invalid Kaizen project slug');
  });

  it('rejects unsafe explicit project slugs before lookup', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-home-'));
    vi.stubEnv('KAIZEN_HOME', home);

    await expect(resolveProject('..', home)).rejects.toThrow('Invalid Kaizen project slug');
  });
});

function project(): RegistryProject {
  return {
    repo: 'owner/repo',
    localPath: '/tmp/repo',
    workspacePath: '/tmp/workspace',
    schedule: '02:00',
    enabled: false,
    createdAt: '2026-06-12T00:00:00Z'
  };
}
