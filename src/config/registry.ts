import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { registryPath } from '../utils/paths.js';
import { ConfigError } from '../utils/errors.js';
import { isProjectSlug } from '../utils/slug.js';
import { registrySchema, type Registry, type RegistryProject } from './schema.js';

export async function loadRegistry(filePath = registryPath()): Promise<Registry> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return registrySchema.parse(JSON.parse(raw));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, projects: {} };
    }
    throw new ConfigError(`Invalid registry at ${filePath}: ${String(error)}`);
  }
}

export async function saveRegistry(registry: Registry, filePath = registryPath()): Promise<void> {
  await registryTransaction(async () => ({ registry, value: undefined }), filePath);
}

export async function updateRegistry(
  update: (registry: Registry) => void | Promise<void>,
  filePath = registryPath()
): Promise<Registry> {
  return registryTransaction(async (registry) => {
    await update(registry);
    return { registry, value: registry };
  }, filePath);
}

export async function registryTransaction<T>(
  transact: (registry: Registry) => Promise<{ registry?: Registry; value: T }>,
  filePath = registryPath()
): Promise<T> {
  return withRegistryLock(filePath, async () => {
    const current = await loadRegistry(filePath);
    const transaction = await transact(current);
    if (transaction.registry) await writeRegistryAtomically(transaction.registry, filePath);
    return transaction.value;
  });
}

export async function upsertProject(slug: string, project: RegistryProject): Promise<Registry> {
  validateProjectSlug(slug);
  return updateRegistry((registry) => {
    registry.projects[slug] = project;
  });
}

export async function findProjectByCwd(cwd: string): Promise<{ slug: string; project: RegistryProject } | undefined> {
  const registry = await loadRegistry();
  const entries = Object.entries(registry.projects);
  const normalizedCwd = path.resolve(cwd);
  const match = entries.find(([, project]) => normalizedCwd.startsWith(path.resolve(project.localPath)));
  if (!match) return undefined;
  return { slug: match[0], project: match[1] };
}

export async function resolveProject(projectSlug: string | undefined, cwd: string): Promise<{ slug: string; project: RegistryProject }> {
  const registry = await loadRegistry();
  if (projectSlug) {
    validateProjectSlug(projectSlug);
    const project = registry.projects[projectSlug];
    if (!project) throw new ConfigError(`Unknown Kaizen project: ${projectSlug}`);
    return { slug: projectSlug, project };
  }

  const byCwd = await findProjectByCwd(cwd);
  if (byCwd) return byCwd;

  throw new ConfigError('Could not resolve project. Pass --project <slug> or run inside a registered project.');
}

function validateProjectSlug(slug: string): void {
  if (!isProjectSlug(slug)) throw new ConfigError(`Invalid Kaizen project slug: ${slug}`);
}

async function writeRegistryAtomically(registry: Registry, filePath: string): Promise<void> {
  const parsed = registrySchema.parse(registry);
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function withRegistryLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await removeStaleLock(lockPath)) continue;
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    try {
      return await action();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }
  throw new ConfigError(`Timed out waiting for registry lock: ${lockPath}`);
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { pid?: number; createdAt?: number };
    if (owner.pid) {
      if (isPidAlive(owner.pid)) return false;
    } else {
      const expired = typeof owner.createdAt !== 'number' || Date.now() - owner.createdAt > 10 * 60 * 1000;
      if (!expired) return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      let stats;
      try {
        stats = await fs.stat(lockPath);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw statError;
      }
      if (Date.now() - stats.mtimeMs < 5_000) return false;
    }
  }
  await fs.rm(lockPath, { recursive: true, force: true });
  return true;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
