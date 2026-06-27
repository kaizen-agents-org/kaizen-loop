import fs from 'node:fs/promises';
import path from 'node:path';
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
  const parsed = registrySchema.parse(registry);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

export async function upsertProject(slug: string, project: RegistryProject): Promise<Registry> {
  validateProjectSlug(slug);
  const registry = await loadRegistry();
  registry.projects[slug] = project;
  await saveRegistry(registry);
  return registry;
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
