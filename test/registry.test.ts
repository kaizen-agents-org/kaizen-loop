import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRegistry, resolveProject, saveRegistry, upsertProject } from '../src/config/registry.js';
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
