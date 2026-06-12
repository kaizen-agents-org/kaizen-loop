import os from 'node:os';
import path from 'node:path';

export function getKaizenHome(): string {
  return process.env.KAIZEN_HOME ?? path.join(os.homedir(), '.kaizen');
}

export function registryPath(): string {
  return path.join(getKaizenHome(), 'registry.json');
}

export function projectStateDir(slug: string): string {
  return path.join(getKaizenHome(), 'projects', slug);
}

export function workspaceDir(slug: string): string {
  return path.join(getKaizenHome(), 'workspaces', slug);
}
