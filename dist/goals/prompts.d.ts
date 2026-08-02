import type { RunSummary } from '../orchestrator/summary.js';
import type { GoalMechanicalEvaluation, GoalState } from './types.js';
export declare function buildGoalPlannerPrompt(goal: GoalState): string;
export declare function buildGoalEvaluatorPrompt(options: {
    goal: GoalState;
    runSummary: RunSummary;
    mechanicalEvaluation?: GoalMechanicalEvaluation;
}): string;
