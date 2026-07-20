export interface RuntimeIdentity {
  commit: string;
  directory?: string;
}

export function runtimeIdentity(env: NodeJS.ProcessEnv = process.env): RuntimeIdentity {
  return {
    commit: env.KAIZEN_RUNTIME_COMMIT || 'development-build',
    ...(env.KAIZEN_RUNTIME_DIR ? { directory: env.KAIZEN_RUNTIME_DIR } : {})
  };
}
