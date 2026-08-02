import { hasPendingPullRequest } from '../report/comments.js';
import { TERMINAL_DISPOSITION_LABELS } from './disposition.js';
const BUILT_IN_EXCLUDED_LABELS = ['kaizen:roadmap'];
export function selectIssues(options) {
    const now = options.now ?? new Date();
    const skipped = [];
    const candidates = options.issues.filter((issue) => {
        if (options.onlyIssue && issue.number !== options.onlyIssue)
            return false;
        const labels = normalizedLabelNames(issue);
        if (!labels.includes(normalizeLabel(options.config.issues.label))) {
            skipped.push({ number: issue.number, reason: `missing required label: ${options.config.issues.label}` });
            return false;
        }
        if (!options.explicit && options.config.issues.selection.mode === 'manual-only') {
            skipped.push({ number: issue.number, reason: 'manual-only selection mode' });
            return false;
        }
        if (!options.explicit &&
            options.config.issues.selection.mode === 'opt-in' &&
            !labels.includes(normalizeLabel(options.config.issues.selection.includeLabel))) {
            skipped.push({ number: issue.number, reason: `missing selection label: ${options.config.issues.selection.includeLabel}` });
            return false;
        }
        const terminalDisposition = TERMINAL_DISPOSITION_LABELS.find((label) => labels.includes(normalizeLabel(label)));
        if (terminalDisposition) {
            skipped.push({
                number: issue.number,
                reason: terminalDisposition === 'kaizen:needs-human'
                    ? 'needs-human'
                    : `terminal disposition: ${terminalDisposition}`
            });
            return false;
        }
        const excludedLabel = BUILT_IN_EXCLUDED_LABELS.find((label) => labels.includes(normalizeLabel(label)))
            ?? options.config.issues.selection.excludeLabels.find((label) => labels.includes(normalizeLabel(label)));
        if (excludedLabel) {
            skipped.push({ number: issue.number, reason: excludedLabel === 'kaizen:needs-human' ? 'needs-human' : `excluded label: ${excludedLabel}` });
            return false;
        }
        if (hasActiveInProgress(issue, now)) {
            skipped.push({ number: issue.number, reason: 'in-progress' });
            return false;
        }
        if (!options.explicit && hasPendingPullRequest(issue.comments ?? [], options.openPullRequests)) {
            skipped.push({ number: issue.number, reason: 'pending pull request' });
            return false;
        }
        return true;
    });
    const sorted = candidates.sort((a, b) => {
        const priority = priorityRank(a, options.config) - priorityRank(b, options.config);
        if (priority !== 0)
            return priority;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
    const selected = sorted.slice(0, options.maxIssues);
    for (const issue of sorted.slice(options.maxIssues)) {
        skipped.push({ number: issue.number, reason: 'maxIssuesPerNight reached' });
    }
    return { selected, skipped };
}
export function labelNames(issue) {
    return (issue.labels ?? []).map((label) => label.name);
}
// GitHub preserves the casing a label was created with, so issue labels can differ in
// case from the configured Kaizen labels. Compare normalized, report configured names.
function normalizeLabel(label) {
    return label.toLowerCase();
}
function normalizedLabelNames(issue) {
    return labelNames(issue).map(normalizeLabel);
}
export function priorityLabel(issue, config) {
    const labels = normalizedLabelNames(issue);
    return config.issues.priorityOrder.find((label) => labels.includes(normalizeLabel(label)));
}
function priorityRank(issue, config) {
    const label = priorityLabel(issue, config);
    return label ? config.issues.priorityOrder.indexOf(label) : config.issues.priorityOrder.length;
}
function hasActiveInProgress(issue, now) {
    const label = issue.labels.find((item) => normalizeLabel(item.name) === 'kaizen:in-progress');
    if (!label)
        return false;
    if (!label.createdAt)
        return true;
    const ageMs = now.getTime() - Date.parse(label.createdAt);
    return ageMs < 24 * 60 * 60 * 1000;
}
//# sourceMappingURL=issues.js.map