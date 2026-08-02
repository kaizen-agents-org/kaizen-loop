import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
import { KaizenError } from '../utils/errors.js';
import { createGoalState, listGoalStates, loadGoalState, saveGoalState, touchGoal } from '../goals/state.js';
import { runGoal } from '../goals/runner.js';
export async function createGoal(options) {
    if (options.successCriteria.length === 0 ||
        options.successCriteria.some((criterion) => criterion.trim().length === 0)) {
        throw new KaizenError('At least one --success criterion is required.', 2);
    }
    const resolved = await resolveProject(options.project, options.cwd);
    const config = await loadConfig(resolved.project.localPath);
    return createGoalState({
        projectSlug: resolved.slug,
        title: options.title,
        description: options.description,
        successCriteria: options.successCriteria,
        constraints: options.constraints,
        maxIterations: options.maxIterations ?? config.goal.maxIterations
    });
}
export async function runGoalCommand(options) {
    return runGoal(options);
}
export async function goalStatus(options) {
    const resolved = await resolveProject(options.project, options.cwd);
    return loadGoalState(resolved.slug, options.goalId);
}
export async function listGoals(options) {
    const resolved = await resolveProject(options.project, options.cwd);
    return listGoalStates(resolved.slug);
}
export async function stopGoal(options) {
    const resolved = await resolveProject(options.project, options.cwd);
    const goal = await loadGoalState(resolved.slug, options.goalId);
    if (goal.status !== 'active') {
        throw new KaizenError(`Goal ${goal.id} is ${goal.status}; only active goals can be stopped.`, 2);
    }
    const stopped = touchGoal({
        ...goal,
        status: 'stopped',
        stoppedReason: options.reason
    });
    await saveGoalState(resolved.slug, stopped);
    return stopped;
}
//# sourceMappingURL=goal.js.map