import { resolveProject } from '../config/registry.js';
import { loadConfig } from '../config/config.js';
import { GitHubClient } from '../github/client.js';
import { runKaizen } from '../orchestrator/run.js';
export async function reportIssue(options) {
    const resolved = await resolveProject(options.project, options.cwd);
    const config = await loadConfig(resolved.project.localPath);
    const github = new GitHubClient(options.runCommand, resolved.project.localPath);
    const labels = [config.issues.label, `kaizen:${options.priority ?? 'P2'}`, ...options.extraLabels];
    if (options.queue) {
        const queueLabels = uniqueLabels([
            config.issues.label,
            config.issues.executionAuthorization.label,
            config.issues.selection.includeLabel
        ]);
        await github.createLabels(queueLabels);
        labels.push(...queueLabels.filter((label) => !labels.includes(label)));
    }
    if (options.direct)
        labels.push('kaizen:direct');
    if (options.prOnly)
        labels.push('kaizen:pr-only');
    if (options.agent)
        labels.push(`kaizen:agent:${options.agent}`);
    return github.createIssue({
        title: options.title,
        body: options.body,
        labels
    });
}
function uniqueLabels(labels) {
    return [...new Set(labels)];
}
export async function reportIssueNow(options) {
    const issue = await reportIssue(options);
    const fix = await runKaizen({
        cwd: options.cwd,
        project: options.project,
        scheduled: Boolean(options.scheduled),
        trigger: options.job ? undefined : 'instant',
        job: options.job,
        issue: issue.number,
        dryRun: false,
        maxIssues: 1,
        agent: options.agent,
        json: options.json,
        assumeYes: Boolean(options.assumeYes),
        confirmDirectCommit: options.confirmDirectCommit,
        existingLock: options.existingLock,
        authorizationEventRetry: options.authorizationEventRetry,
        runCommand: options.runCommand
    });
    return { issue, fix };
}
//# sourceMappingURL=report.js.map