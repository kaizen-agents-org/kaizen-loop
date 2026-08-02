import { type CommandRunner } from '../utils/command.js';
import type { GoalEvaluation, GoalPlan } from './types.js';
export interface GoalAgentOptions {
    command: string;
    args: string[];
    resultPath: string;
    timeoutMinutes: number;
    envAllowlist: string[];
}
export interface GoalAgentRequest {
    cwd: string;
    stateDir: string;
    prompt: string;
}
export declare class GoalAgentAdapter {
    private readonly runCommand;
    private readonly options;
    constructor(runCommand: CommandRunner, options: GoalAgentOptions);
    plan(req: GoalAgentRequest): Promise<GoalPlan>;
    evaluate(req: GoalAgentRequest): Promise<GoalEvaluation>;
    private run;
}
