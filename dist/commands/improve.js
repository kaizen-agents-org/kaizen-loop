import { runKaizen } from '../orchestrator/run.js';
export async function planImprove(options) {
    const result = await runKaizen({
        cwd: options.cwd,
        project: options.project,
        scheduled: false,
        trigger: 'instant',
        issueNumbers: options.issueNumbers,
        dryRun: true,
        maxIssues: maxIssuesFor(options),
        agent: options.agent,
        json: options.json,
        runCommand: options.runCommand
    });
    if ('issues' in result) {
        return { selected: [], skipped: result.skipped };
    }
    return result;
}
export async function runImprove(options) {
    return runKaizen({
        cwd: options.cwd,
        project: options.project,
        scheduled: false,
        trigger: 'instant',
        issueNumbers: options.issueNumbers,
        dryRun: options.dryRun,
        maxIssues: maxIssuesFor(options),
        agent: options.agent,
        json: options.json,
        confirmDirectCommit: options.confirmDirectCommit,
        runCommand: options.runCommand
    });
}
function maxIssuesFor(options) {
    return options.maxIssues ?? (options.issueNumbers && options.issueNumbers.length > 0 ? options.issueNumbers.length : undefined);
}
//# sourceMappingURL=improve.js.map