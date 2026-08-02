export declare function resolveKaizenTempDir(cwd?: string, env?: NodeJS.ProcessEnv): string;
export declare function ensureKaizenTempDir(cwd?: string, env?: NodeJS.ProcessEnv): Promise<string>;
export declare function envWithKaizenTemp(env?: NodeJS.ProcessEnv, cwd?: string): Promise<NodeJS.ProcessEnv>;
