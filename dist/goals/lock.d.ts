export declare class GoalLock {
    private readonly lockPath;
    private constructor();
    static acquire(goalDir: string): Promise<GoalLock>;
    release(): Promise<void>;
}
