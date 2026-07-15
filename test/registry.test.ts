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
