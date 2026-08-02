import type { DirectCommitConfirmation } from '../orchestrator/run.js';
import type { CommandRunner } from '../utils/command.js';
export interface CreateGoalOptions {
    cwd: string;
    project?: string;
    title: string;
    description: string;
    successCriteria: string[];
    constraints: string[];
    maxIterations?: number;
}
export interface GoalRunOptions {
    cwd: string;
    project?: string;
    goalId: string;
    agent?: 'claude' | 'codex';
    assumeYes?: boolean;
    json: boolean;
    confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<'direct' | 'pr' | 'reject'>;
    runCommand: CommandRunner;
}
export declare function createGoal(options: CreateGoalOptions): Promise<import("../index.js").GoalState>;
export declare function runGoalCommand(options: GoalRunOptions): Promise<import("../index.js").GoalState>;
export declare function goalStatus(options: {
    cwd: string;
    project?: string;
    goalId: string;
}): Promise<import("../index.js").GoalState>;
export declare function listGoals(options: {
    cwd: string;
    project?: string;
}): Promise<import("../index.js").GoalState[]>;
export declare function stopGoal(options: {
    cwd: string;
    project?: string;
    goalId: string;
    reason: string;
}): Promise<import("../index.js").GoalState>;
