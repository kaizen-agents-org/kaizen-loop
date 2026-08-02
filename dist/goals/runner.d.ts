import { type DirectCommitConfirmation } from '../orchestrator/run.js';
import { type CommandRunner } from '../utils/command.js';
import type { GoalState } from './types.js';
export interface RunGoalOptions {
    cwd: string;
    project?: string;
    goalId: string;
    agent?: 'claude' | 'codex';
    assumeYes?: boolean;
    json: boolean;
    confirmDirectCommit?: (context: DirectCommitConfirmation) => Promise<'direct' | 'pr' | 'reject'>;
    runCommand: CommandRunner;
}
export declare function runGoal(options: RunGoalOptions): Promise<GoalState>;
