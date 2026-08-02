export declare class RunLock {
    private readonly lockPath;
    private constructor();
    static acquire(projectDir: string): Promise<RunLock>;
    static isActiveError(error: unknown): boolean;
    release(): Promise<void>;
}
