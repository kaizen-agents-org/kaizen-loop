import type { GoalState } from './types.js';
export declare function goalsDir(projectSlug: string): string;
export declare function goalDir(projectSlug: string, goalId: string): string;
export declare function goalPath(projectSlug: string, goalId: string): string;
export declare function createGoalState(options: {
    projectSlug: string;
    title: string;
    description: string;
    successCriteria: string[];
    constraints: string[];
    maxIterations: number;
    now?: Date;
}): Promise<GoalState>;
export declare function loadGoalState(projectSlug: string, goalId: string): Promise<GoalState>;
export declare function saveGoalState(projectSlug: string, goal: GoalState): Promise<void>;
export declare function listGoalStates(projectSlug: string): Promise<GoalState[]>;
export declare function touchGoal(goal: GoalState, now?: Date): GoalState;
