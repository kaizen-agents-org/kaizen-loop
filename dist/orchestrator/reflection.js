export function decideReflection(options) {
    const { config, labels, diff, verifyConfigured } = options;
    if (!verifyConfigured) {
        return { action: 'pr', reason: 'Verification commands are not configured.' };
    }
    if (labels.includes('kaizen:pr-only')) {
        return { action: 'pr', reason: 'Issue has kaizen:pr-only label.' };
    }
    if (diff.protectedFiles.length > 0) {
        return { action: 'pr', reason: `Protected paths changed: ${diff.protectedFiles.join(', ')}` };
    }
    if (config.policy.mode === 'pr-only') {
        return { action: 'pr', reason: 'Repository policy is pr-only.' };
    }
    if (config.policy.mode === 'direct-only') {
        return { action: 'direct', reason: 'Repository policy is direct-only and verification passed.' };
    }
    if (labels.includes('kaizen:direct')) {
        return { action: 'direct', reason: 'Issue has kaizen:direct label and verification passed.' };
    }
    if (diff.changedLines <= config.policy.directCommit.maxChangedLines &&
        diff.changedFiles <= config.policy.directCommit.maxChangedFiles) {
        return {
            action: 'direct',
            reason: `Changed ${diff.changedLines} lines / ${diff.changedFiles} files within direct commit limits.`
        };
    }
    return {
        action: 'pr',
        reason: `Changed ${diff.changedLines} lines / ${diff.changedFiles} files exceeds direct commit limits.`
    };
}
//# sourceMappingURL=reflection.js.map