export interface RuntimeIdentity {
    commit: string;
    directory?: string;
}
export declare function runtimeIdentity(env?: NodeJS.ProcessEnv): RuntimeIdentity;
