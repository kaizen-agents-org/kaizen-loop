import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRegistry, saveRegistry } from '../src/config/registry.js';

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
