export const GENERATED_PULL_REQUEST_FETCH_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GENERATED_BRANCH_PREFIXES = ['kaizen/', 'codex/', 'claude/'];
const GENERATED_TITLE_PREFIXES = ['[WIP] kaizen:', '[scout]', '[monitor]', 'kaizen:'];
export function pullRequestsInRepositories(pullRequests, repositories) {
    const normalizedRepositories = new Set(Array.from(repositories, (repo) => repo.toLowerCase()));
    return pullRequests.filter((pullRequest) => {
        const repo = pullRequest.repository?.nameWithOwner;
        if (repo === undefined) {
            throw new Error(`Cannot scope pull request #${pullRequest.number}: repository is missing`);
        }
        return normalizedRepositories.has(repo.toLowerCase());
    });
}
export function summarizeGeneratedPullRequestBacklog(options) {
    const generatedPullRequests = options.pullRequests.filter(isGeneratedPullRequest);
    const normalizedRepo = options.repo.toLowerCase();
    const organization = generatedPullRequests.length;
    const repository = generatedPullRequests.filter((pullRequest) => pullRequest.repository?.nameWithOwner?.toLowerCase() === normalizedRepo).length;
    const oldestGeneratedPullRequestCreatedAt = oldestPullRequestCreatedAt(generatedPullRequests);
    return {
        repository,
        organization,
        limit: options.wipLimit,
        exceeded: options.wipLimit === 0 || organization >= options.wipLimit,
        oldestGeneratedPullRequestCreatedAt,
        oldestGeneratedPullRequestAgeDays: oldestGeneratedPullRequestCreatedAt
            ? elapsedDaysSince(oldestGeneratedPullRequestCreatedAt)
            : undefined
    };
}
export function generatedPullRequestWipLimitReason(backlog) {
    return `generated pull request WIP limit reached (organization ${backlog.organization}/${backlog.limit}, repository ${backlog.repository})`;
}
export function isGeneratedPullRequest(pullRequest) {
    if (isSyncPullRequest(pullRequest))
        return false;
    if (GENERATED_BRANCH_PREFIXES.some((prefix) => pullRequest.headRefName?.startsWith(prefix)))
        return true;
    if (GENERATED_TITLE_PREFIXES.some((prefix) => pullRequest.title?.startsWith(prefix)))
        return true;
    return false;
}
export function isSyncPullRequest(pullRequest) {
    return [
        'codex/daily-dogfood-sync',
        'codex/sync-kaizen-dogfood',
        'codex/sync-kaizen-shared-skills'
    ].includes(pullRequest.headRefName ?? '');
}
function oldestPullRequestCreatedAt(pullRequests) {
    return pullRequests.reduce((oldest, pullRequest) => {
        if (!isValidIsoDate(pullRequest.createdAt))
            return oldest;
        if (!oldest)
            return pullRequest.createdAt;
        return Date.parse(pullRequest.createdAt) < Date.parse(oldest) ? pullRequest.createdAt : oldest;
    }, undefined);
}
function elapsedDaysSince(isoDate) {
    return Math.max(0, Math.floor((Date.now() - Date.parse(isoDate)) / DAY_MS));
}
function isValidIsoDate(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
//# sourceMappingURL=wipLimit.js.map