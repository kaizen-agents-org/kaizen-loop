export declare class GoalLock {
    private readonly lockPath;
    private readonly identity;
    private constructor();
    static acquire(goalDir: string): Promise<GoalLock>;
    assertHeld(): Promise<void>;
    release(): Promise<void>;
}
