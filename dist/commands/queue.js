import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
import { GitHubClient } from '../github/client.js';
export async function queueIssues(options) {
    const resolved = await resolveProject(options.project, options.cwd);
    const config = await loadConfig(resolved.project.localPath);
    const github = new GitHubClient(options.runCommand, resolved.project.localPath);
    const labels = uniqueLabels([
        config.issues.label,
        config.issues.executionAuthorization.label,
        config.issues.selection.includeLabel
    ]);
    await github.createLabels(labels);
    for (const issue of uniqueIssues(options.issues)) {
        await github.addLabels(issue, labels);
    }
    return { queued: uniqueIssues(options.issues), labels };
}
export async function unqueueIssues(options) {
    const resolved = await resolveProject(options.project, options.cwd);
    const config = await loadConfig(resolved.project.localPath);
    const github = new GitHubClient(options.runCommand, resolved.project.localPath);
    const label = config.issues.selection.includeLabel;
    for (const issue of uniqueIssues(options.issues)) {
        await github.removeLabels(issue, [label]);
    }
    return { unqueued: uniqueIssues(options.issues), label };
}
export async function listQueuedIssues(options) {
    const resolved = await resolveProject(options.project, options.cwd);
    const config = await loadConfig(resolved.project.localPath);
    const github = new GitHubClient(options.runCommand, resolved.project.localPath);
    const issueLabels = config.safety.operationMode === 'external'
        ? [config.issues.selection.includeLabel, config.issues.executionAuthorization.label]
        : config.issues.selection.includeLabel;
    const issues = await github.listIssues(issueLabels);
    return {
        label: config.issues.selection.includeLabel,
        issues: issues.filter((issue) => hasLabel(issue, config.issues.label) &&
            (config.safety.operationMode === 'dogfood' ||
                hasLabel(issue, config.issues.executionAuthorization.label)))
    };
}
function hasLabel(issue, expected) {
    const normalizedExpected = expected.toLowerCase();
    return issue.labels.some((label) => label.name.toLowerCase() === normalizedExpected);
}
function uniqueIssues(issues) {
    return [...new Set(issues)];
}
function uniqueLabels(labels) {
    return [...new Set(labels)];
}
//# sourceMappingURL=queue.js.map