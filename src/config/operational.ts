import path from 'node:path';
import { loadConfig } from './config.js';
import type { KaizenConfig, RegistryProject } from './schema.js';
import { ConfigError } from '../utils/errors.js';

export interface OperationalConfig {
  config: KaizenConfig;
  source: 'local' | 'workspace';
  path: string;
}

export async function loadOperationalConfig(
  project: RegistryProject,
  options: { preferWorkspace: boolean; requireWorkspace?: boolean }
): Promise<OperationalConfig> {
  if (options.preferWorkspace) {
    try {
      return {
        config: await loadConfig(project.workspacePath),
        source: 'workspace',
        path: project.workspacePath
      };
    } catch (error) {
      if (options.requireWorkspace || !isMissingConfig(error)) throw error;
    }
  }

  return {
    config: await loadConfig(project.localPath),
    source: 'local',
    path: project.localPath
  };
}

export function configDrift(
  local: KaizenConfig,
  workspace: KaizenConfig,
  paths: { localPath: string; workspacePath: string }
) {
  const detected = JSON.stringify(local) !== JSON.stringify(workspace);
  return {
    detected,
    localPath: path.join(paths.localPath, '.kaizen', 'config.yml'),
    workspacePath: path.join(paths.workspacePath, '.kaizen', 'config.yml'),
    message: detected ? 'developer checkout config differs from fleet workspace config' : undefined
  };
}

function isMissingConfig(error: unknown): boolean {
  return error instanceof ConfigError && error.message.includes('Missing Kaizen config:');
}
