import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildAllowlistedEnv, githubCliEnv } from '../utils/command.js';
import { envWithKaizenTemp } from '../utils/temp.js';
import { GitClient } from '../workspace/git.js';
import { loadImplementationState, saveImplementationState } from './implementationState.js';
import { isSyncPullRequest } from './wipLimit.js';
export const MANAGED_PR_GUARDIAN_MARKER = '<!-- kaizen-pr-guardian:managed -->';
export function guardianJobsDir(stateDir) {
    return path.join(stateDir, 'guardian', 'jobs');
}
export async function enqueuePrGuardianJob(options) {
    const now = new Date().toISOString();
    const job = {
        version: 1,
        id: guardianJobId(options.repo, options.prNumber, options.headSha),
        repo: options.repo,
        prUrl: options.prUrl,
        prNumber: options.prNumber,
        issueNumber: options.issueNumber,
        branch: options.branch,
        baseBranch: options.baseBranch,
        headSha: options.headSha,
        retryBudget: options.config.guardian.maxAttempts,
        attemptCount: 0,
        status: options.config.guardian.enabled ? 'pending' : 'skipped',
        createdAt: now,
        updatedAt: now,
        lastBlocker: options.config.guardian.enabled ? undefined : 'PR guardian is disabled.'
    };
    const existing = await readGuardianJob(options.stateDir, job.id);
    if (existing) {
        if (options.issueNumber && !existing.issueNumber) {
            const linked = { ...existing, issueNumber: options.issueNumber, updatedAt: now };
            await writeGuardianJob(options.stateDir, linked);
            return linked;
        }
        return existing;
    }
    await writeGuardianJob(options.stateDir, job);
    return job;
}
export async function enqueueManagedPrGuardianJobs(options) {
    const [owner] = options.repo.split('/');
    const managed = options.pullRequests.filter((pullRequest) => !pullRequest.isDraft &&
        isSyncPullRequest(pullRequest) &&
        pullRequest.body?.includes(MANAGED_PR_GUARDIAN_MARKER) &&
        pullRequest.headRepositoryOwner?.login?.toLowerCase() === owner?.toLowerCase() &&
        pullRequest.baseRefName === options.config.git.defaultBranch &&
        Boolean(pullRequest.headRefName && pullRequest.headRefOid));
    return Promise.all(managed.map((pullRequest) => enqueuePrGuardianJob({
        stateDir: options.stateDir,
        config: options.config,
        repo: options.repo,
        prUrl: pullRequest.url,
        prNumber: pullRequest.number,
        branch: pullRequest.headRefName,
        baseBranch: pullRequest.baseRefName,
        headSha: pullRequest.headRefOid
    })));
}
export async function listPrGuardianJobs(stateDir) {
    try {
        const dir = guardianJobsDir(stateDir);
        const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json')).sort();
        return (await Promise.all(files.map((file) => readGuardianJobFile(path.join(dir, file))))).filter((job) => Boolean(job));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}
export async function findPrGuardianJob(stateDir, pr) {
    return (await listPrGuardianJobs(stateDir))
        .filter((job) => job.prNumber === pr)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .at(0);
}
export async function runPrGuardianJob(options) {
    const running = {
        ...options.job,
        status: 'running',
        attemptCount: options.job.attemptCount + 1,
        updatedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString()
    };
    await writeGuardianJob(options.stateDir, running);
    const execute = async (workspaceDir) => runPrGuardianSkill(options.runCommand, {
        config: options.config,
        workspaceDir,
        repo: running.repo,
        prUrl: running.prUrl,
        prNumber: running.prNumber,
        branch: running.branch,
        baseBranch: running.baseBranch
    });
    let result;
    try {
        result = options.isolateWorktree
            ? await withGuardianWorktree(options, running, execute)
            : await execute(options.workspaceDir);
    }
    catch (error) {
        result = {
            status: 'failed',
            summary: `PR guardian worktree failed: ${String(error)}`,
            raw: String(error),
            durationMs: 0
        };
    }
    const finished = {
        ...running,
        status: result.status === 'success' ? 'success' : result.status === 'skipped' ? 'skipped' : 'blocked',
        updatedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        lastBlocker: result.status === 'success' ? undefined : result.summary
    };
    await writeGuardianJob(options.stateDir, finished);
    await syncImplementationState(options.stateDir, finished);
    return finished;
}
async function syncImplementationState(stateDir, job) {
    if (!job.issueNumber)
        return;
    const current = await loadImplementationState(stateDir, job.issueNumber);
    await saveImplementationState(stateDir, {
        issue: job.issueNumber,
        branch: job.branch,
        phase: job.status === 'success' ? 'complete' : 'guardian',
        attempt: current?.attempt ?? job.attemptCount,
        pr: job.prNumber,
        prUrl: job.prUrl,
        lastFailure: job.status === 'blocked' ? job.lastBlocker : undefined
    });
}
export async function runPendingPrGuardianJobs(options) {
    let jobs = await listPrGuardianJobs(options.stateDir);
    const reconciledTerminalJobs = [];
    for (const job of jobs.filter((candidate) => (candidate.status === 'blocked' && candidate.attemptCount >= candidate.retryBudget) ||
        (isStaleRunningJob(candidate, options.config.guardian.timeoutMinutes) && candidate.attemptCount >= candidate.retryBudget))) {
        let resolution;
        try {
            resolution = await inspectPullRequestTerminalState(options.runCommand, requestForJob(options, job));
        }
        catch {
            continue;
        }
        if (resolution.state !== 'MERGED' ||
            resolution.baseRefName !== options.config.git.defaultBranch ||
            !job.issueNumber ||
            !resolution.closingIssuesReferences?.some((issue) => issue.number === job.issueNumber))
            continue;
        const now = new Date().toISOString();
        const terminal = {
            ...job,
            status: 'success',
            updatedAt: now,
            lastCheckedAt: now,
            lastBlocker: undefined,
            lastObservedFingerprint: JSON.stringify(resolution)
        };
        await writeGuardianJob(options.stateDir, terminal);
        await syncImplementationState(options.stateDir, terminal);
        reconciledTerminalJobs.push(terminal);
    }
    if (reconciledTerminalJobs.length > 0)
        jobs = await listPrGuardianJobs(options.stateDir);
    const reconciledTerminalJobIds = new Set(reconciledTerminalJobs.map((job) => job.id));
    for (const job of jobs.filter((candidate) => candidate.status === 'success' && !reconciledTerminalJobIds.has(candidate.id))) {
        let gate;
        try {
            gate = await inspectPrGate(options.runCommand, requestForJob(options, job));
        }
        catch {
            continue;
        }
        if (gate.state !== 'OPEN') {
            if (job.lastObservedFingerprint !== gate.activityFingerprint) {
                await writeGuardianJob(options.stateDir, { ...job, lastObservedFingerprint: gate.activityFingerprint });
            }
            continue;
        }
        const observedJob = gate.headRefOid && gate.headRefOid !== job.headSha
            ? { ...job, headSha: gate.headRefOid }
            : job;
        if (gate.isReady) {
            if (observedJob !== job || job.lastObservedFingerprint !== gate.activityFingerprint) {
                await writeGuardianJob(options.stateDir, {
                    ...observedJob,
                    lastObservedFingerprint: gate.activityFingerprint
                });
            }
            continue;
        }
        await writeGuardianJob(options.stateDir, {
            ...observedJob,
            status: 'pending',
            reactivationCount: (job.reactivationCount ?? 0) + 1,
            lastObservedFingerprint: gate.activityFingerprint,
            updatedAt: new Date().toISOString(),
            lastBlocker: `PR regressed after guardian success: ${gate.blockers.join('; ')}`
        });
    }
    jobs = await listPrGuardianJobs(options.stateDir);
    for (const job of jobs) {
        if (isStaleRunningJob(job, options.config.guardian.timeoutMinutes) && job.attemptCount >= job.retryBudget) {
            const now = new Date().toISOString();
            const blocked = {
                ...job,
                status: 'blocked',
                updatedAt: now,
                lastCheckedAt: now,
                lastBlocker: `PR guardian retry budget exhausted after ${job.attemptCount} attempts.`
            };
            await writeGuardianJob(options.stateDir, blocked);
            await syncImplementationState(options.stateDir, blocked);
        }
    }
    const runnable = jobs.filter((job) => job.status === 'pending' ||
        (isStaleRunningJob(job, options.config.guardian.timeoutMinutes) && job.attemptCount < job.retryBudget) ||
        (job.status === 'blocked' && job.attemptCount < job.retryBudget));
    const results = [];
    for (const job of runnable) {
        results.push(await runPrGuardianJob({ ...options, job }));
    }
    return [...reconciledTerminalJobs, ...results];
}
function requestForJob(options, job) {
    return {
        config: options.config,
        workspaceDir: options.workspaceDir,
        repo: job.repo,
        prUrl: job.prUrl,
        prNumber: job.prNumber,
        branch: job.branch,
        baseBranch: job.baseBranch
    };
}
async function withGuardianWorktree(options, job, execute) {
    const git = new GitClient(options.runCommand, options.workspaceDir);
    const worktreePath = path.join(options.stateDir, 'guardian', 'worktrees', job.id);
    const localBranch = `kaizen-guardian/pr-${job.prNumber}-${job.headSha.slice(0, 12)}`;
    await git.fetch();
    await git.worktreePrune();
    await git.worktreeRemove(worktreePath);
    await fs.rm(worktreePath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await git.deleteLocalBranch(localBranch);
    await git.worktreeAdd(worktreePath, localBranch, job.headSha);
    try {
        return await execute(worktreePath);
    }
    finally {
        await git.worktreeRemove(worktreePath);
        await fs.rm(worktreePath, { recursive: true, force: true });
        await git.deleteLocalBranch(localBranch);
        await git.worktreePrune();
    }
}
export async function runPrGuardianSkill(runCommand, req) {
    if (!req.config.guardian.enabled) {
        return { status: 'skipped', summary: 'PR guardian skill is disabled.', raw: '', durationMs: 0 };
    }
    const startMs = Date.now();
    const maxAttempts = req.config.guardian.maxAttempts;
    const rawOutputs = [];
    try {
        const initialState = await inspectPullRequest(runCommand, req);
        if (initialState.state === 'MERGED') {
            return {
                status: 'success',
                summary: successSummary({ ...initialState, isReady: true, blockers: [] }),
                raw: '',
                durationMs: Date.now() - startMs
            };
        }
        const initialGate = await inspectPrGate(runCommand, req);
        const settledInitialGate = initialGate.isReady
            ? await waitForStablePrGate(runCommand, req, initialGate)
            : await waitForInitiallyReadyPrGate(runCommand, req, initialGate);
        if (settledInitialGate.isReady) {
            return {
                status: 'success',
                summary: successSummary(settledInitialGate),
                raw: '',
                durationMs: Date.now() - startMs
            };
        }
        rawOutputs.push(`PR was not stably merge-ready before the first guardian pass:\n${summarizeGate(settledInitialGate)}`);
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (attempt > 1) {
                const preflight = await inspectPrGate(runCommand, req);
                if (preflight.isReady) {
                    const stablePreflight = await waitForStablePrGate(runCommand, req, preflight);
                    if (stablePreflight.isReady) {
                        return {
                            status: 'success',
                            summary: successSummary(stablePreflight),
                            raw: rawOutputs.join('\n'),
                            durationMs: Date.now() - startMs
                        };
                    }
                    rawOutputs.push(`PR became not merge-ready after retry preflight settle wait before pass ${attempt}:\n${summarizeGate(stablePreflight)}`);
                }
                else {
                    rawOutputs.push(`PR still not merge-ready before guardian pass ${attempt}:\n${summarizeGate(preflight)}`);
                }
            }
            let result;
            try {
                result = await runCommand(req.config.guardian.command, [
                    'exec',
                    '--cd',
                    req.workspaceDir,
                    '--dangerously-bypass-approvals-and-sandbox',
                    buildPrompt(req, attempt)
                ], {
                    cwd: req.workspaceDir,
                    env: await envWithKaizenTemp(buildAllowlistedEnv(process.env, req.config.safety.envAllowlist), req.workspaceDir),
                    timeoutMs: boundedTimeoutMs(req.config.guardian.timeoutMinutes * 60_000, req.runDeadlineAt),
                    rejectOnNonZero: false
                });
            }
            catch (error) {
                const failure = error instanceof Error ? error.message : String(error);
                rawOutputs.push(failure);
                return finishAfterGuardianCommandFailure(runCommand, req, rawOutputs, startMs, failure);
            }
            rawOutputs.push(`${result.stdout}${result.stderr}`);
            if (result.exitCode !== 0) {
                return finishAfterGuardianCommandFailure(runCommand, req, rawOutputs, startMs, `PR guardian skill exited with code ${result.exitCode}.`);
            }
            const gate = await inspectPrGate(runCommand, req);
            if (gate.isReady) {
                const lateGate = await waitForStablePrGate(runCommand, req, gate);
                if (!lateGate.isReady) {
                    rawOutputs.push(`PR became not merge-ready after bot review settle wait on pass ${attempt}:\n${summarizeGate(lateGate)}`);
                    continue;
                }
                return {
                    status: 'success',
                    summary: successSummary(lateGate),
                    raw: rawOutputs.join('\n'),
                    durationMs: Date.now() - startMs
                };
            }
            rawOutputs.push(`PR still not merge-ready after guardian pass ${attempt}:\n${summarizeGate(gate)}`);
        }
        const finalGate = await inspectPrGate(runCommand, req);
        return {
            status: 'failed',
            summary: `PR guardian stopped before PR became merge-ready after ${maxAttempts} attempt(s): ${finalGate.blockers.join('; ') || 'unknown blocker'}.`,
            raw: rawOutputs.join('\n'),
            durationMs: Date.now() - startMs
        };
    }
    catch (error) {
        return {
            status: 'failed',
            summary: String(error),
            raw: String(error),
            durationMs: Date.now() - startMs
        };
    }
}
async function readGuardianJob(stateDir, id) {
    return readGuardianJobFile(path.join(guardianJobsDir(stateDir), `${id}.json`));
}
async function readGuardianJobFile(file) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        console.warn(`Skipping unreadable PR Guardian job file ${file}: ${String(error)}`);
        return undefined;
    }
}
async function writeGuardianJob(stateDir, job) {
    const dir = guardianJobsDir(stateDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`);
}
function guardianJobId(repo, prNumber, headSha) {
    const safeRepo = repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    return `${safeRepo}-pr-${prNumber}-${headSha.slice(0, 12)}`;
}
function isStaleRunningJob(job, timeoutMinutes) {
    if (job.status !== 'running')
        return false;
    const lastCheckedAtMs = Date.parse(job.lastCheckedAt ?? job.updatedAt);
    if (Number.isNaN(lastCheckedAtMs))
        return true;
    return Date.now() - lastCheckedAtMs > timeoutMinutes * 60_000;
}
export async function isPrGuardianSkillRunnerAvailable(config, runCommand) {
    try {
        await runCommand(config.guardian.command, ['--version'], {
            rejectOnNonZero: true,
            timeoutMs: 30_000,
            env: buildAllowlistedEnv(process.env, config.safety.envAllowlist)
        });
        return true;
    }
    catch {
        return false;
    }
}
const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 1) {
            nodes {
              body
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}`;
async function listUnresolvedReviewThreads(runCommand, req) {
    const [owner, name] = req.repo.split('/');
    if (!owner || !name)
        throw new Error(`Cannot inspect PR review threads for invalid repo: ${req.repo}`);
    const unresolved = [];
    let cursor;
    let hasNextPage = true;
    while (hasNextPage) {
        const args = [
            'api',
            'graphql',
            '-f',
            `query=${REVIEW_THREADS_QUERY}`,
            '-F',
            `owner=${owner}`,
            '-F',
            `name=${name}`,
            '-F',
            `number=${req.prNumber}`
        ];
        if (cursor)
            args.push('-F', `cursor=${cursor}`);
        const result = await runCommand('gh', args, {
            cwd: req.workspaceDir,
            env: githubCliEnv(),
            timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
            rejectOnNonZero: false
        });
        if (result.exitCode !== 0) {
            throw new Error(`Could not inspect PR review threads: ${result.stderr || result.stdout}`);
        }
        const response = JSON.parse(result.stdout || '{}');
        if (response.errors?.length) {
            throw new Error(`Could not inspect PR review threads: ${response.errors.map((error) => error.message).join('; ')}`);
        }
        const reviewThreads = response.data?.repository?.pullRequest?.reviewThreads;
        if (!reviewThreads)
            throw new Error('Could not inspect PR review threads: response did not include reviewThreads.');
        for (const thread of reviewThreads?.nodes ?? []) {
            if (thread.isResolved)
                continue;
            const firstComment = thread.comments?.nodes?.[0];
            unresolved.push({
                path: thread.path ?? '(unknown path)',
                line: thread.line,
                author: firstComment?.author?.login,
                body: firstComment?.body
            });
        }
        hasNextPage = Boolean(reviewThreads?.pageInfo?.hasNextPage);
        cursor = reviewThreads?.pageInfo?.endCursor ?? undefined;
    }
    return unresolved;
}
async function inspectPrGate(runCommand, req) {
    const [pullRequest, unresolvedThreads] = await Promise.all([
        inspectPullRequest(runCommand, req),
        listUnresolvedReviewThreads(runCommand, req)
    ]);
    const terminal = pullRequest.state === 'MERGED';
    const blockers = [
        ...mergeabilityBlockers(pullRequest),
        ...(pullRequest.reviewBlockers ?? []),
        ...(terminal ? [] : unresolvedThreads.map((thread) => {
            const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
            const author = thread.author ? ` by ${thread.author}` : '';
            return `unresolved review thread at ${location}${author}`;
        }))
    ];
    return {
        ...pullRequest,
        activityFingerprint: JSON.stringify({
            pullRequest: pullRequest.activityFingerprint,
            unresolvedThreads
        }),
        blockers,
        isReady: blockers.length === 0
    };
}
async function inspectPullRequestTerminalState(runCommand, req) {
    const result = await runCommand('gh', [
        'pr',
        'view',
        String(req.prNumber),
        '--repo',
        req.repo,
        '--json',
        'state,baseRefName,closingIssuesReferences'
    ], {
        cwd: req.workspaceDir,
        env: githubCliEnv(),
        timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
        rejectOnNonZero: false
    });
    if (result.exitCode !== 0) {
        throw new Error(`Could not inspect PR state: ${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout || '{}');
}
async function inspectPullRequest(runCommand, req) {
    const [result, reviews, requiredChecks] = await Promise.all([
        runCommand('gh', [
            'pr',
            'view',
            String(req.prNumber),
            '--repo',
            req.repo,
            '--json',
            'state,isDraft,mergeStateStatus,mergeable,reviewDecision,headRefOid,comments,statusCheckRollup'
        ], {
            cwd: req.workspaceDir,
            env: githubCliEnv(),
            timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
            rejectOnNonZero: false
        }),
        listPullRequestReviews(runCommand, req),
        listRequiredChecks(runCommand, req)
    ]);
    if (result.exitCode !== 0) {
        throw new Error(`Could not inspect PR mergeability: ${result.stderr || result.stdout}`);
    }
    const parsed = JSON.parse(result.stdout || '{}');
    return {
        state: parsed.state,
        isDraft: parsed.isDraft,
        mergeStateStatus: parsed.mergeStateStatus,
        mergeable: parsed.mergeable,
        reviewDecision: parsed.reviewDecision,
        headRefOid: parsed.headRefOid,
        activityFingerprint: JSON.stringify({
            headRefOid: parsed.headRefOid,
            checks: requiredChecks,
            reviews: reviews.map((review) => [review.id, review.submitted_at, review.state, review.commit_id]),
            comments: (parsed.comments ?? []).map((comment) => [comment.id, comment.updatedAt])
        }),
        reviewBlockers: [
            ...currentHeadReviewBlockers(parsed, reviews),
            ...commentAuditBlockers(parsed)
        ],
        checks: requiredChecks
    };
}
async function listRequiredChecks(runCommand, req) {
    const result = await runCommand('gh', [
        'pr',
        'checks',
        String(req.prNumber),
        '--repo',
        req.repo,
        '--required',
        '--json',
        'name,state,bucket,workflow'
    ], {
        cwd: req.workspaceDir,
        env: githubCliEnv(),
        timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
        rejectOnNonZero: false
    });
    if (!result.stdout.trim()) {
        if (result.exitCode === 0)
            return [];
        if (/^no (?:required )?checks reported on the '.+' branch$/i.test(result.stderr.trim()))
            return [];
        throw new Error(`Could not inspect required PR checks: ${result.stderr || `exit ${result.exitCode}`}`);
    }
    const checks = JSON.parse(result.stdout);
    return checks.map((check) => ({
        name: check.name ?? '(unknown check)',
        status: check.bucket === 'pass' || check.bucket === 'skipping' ? 'SUCCESS' : String(check.state ?? check.bucket ?? '')
    }));
}
async function listPullRequestReviews(runCommand, req) {
    const result = await runCommand('gh', [
        'api',
        `repos/${req.repo}/pulls/${req.prNumber}/reviews?per_page=100`,
        '--paginate',
        '--slurp'
    ], {
        cwd: req.workspaceDir,
        env: githubCliEnv(),
        timeoutMs: boundedTimeoutMs(60_000, req.runDeadlineAt),
        rejectOnNonZero: false
    });
    if (result.exitCode !== 0) {
        throw new Error(`Could not inspect PR reviews: ${result.stderr || result.stdout}`);
    }
    const pages = JSON.parse(result.stdout || '[]');
    return Array.isArray(pages[0])
        ? pages.flat()
        : pages;
}
function currentHeadReviewBlockers(parsed, reviews) {
    if (!parsed.headRefOid || parsed.state === 'MERGED')
        return [];
    const latestByBot = new Map();
    for (const review of reviews) {
        const login = normalizeReviewerLogin(review.user?.login);
        if (!login.includes('codex') && !login.includes('coderabbit'))
            continue;
        const current = latestByBot.get(login);
        if (!current || String(review.submitted_at ?? '') > String(current.submitted_at ?? ''))
            latestByBot.set(login, review);
    }
    return [...latestByBot.entries()].flatMap(([login, review]) => {
        if (hasCurrentHeadBotEvidence(login, parsed))
            return [];
        if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(review.state ?? '')) {
            return [`${login} review is not terminal for current PR head ${parsed.headRefOid}`];
        }
        return review.commit_id === parsed.headRefOid
            ? []
            : [`${login} review is not for current PR head ${parsed.headRefOid}`];
    });
}
function hasCurrentHeadBotEvidence(login, parsed) {
    if (!parsed.headRefOid)
        return false;
    if (login.includes('codex')) {
        return (parsed.comments ?? []).some((comment) => {
            if (!normalizeReviewerLogin(comment.author?.login).includes('codex'))
                return false;
            const reviewedCommit = comment.body?.match(/Reviewed commit:\*{0,2}\s*`([0-9a-f]{7,40})`/i)?.[1];
            const noFindings = /did(?:n't| not) find any (?:major )?issues/i.test(comment.body ?? '');
            return Boolean(reviewedCommit && parsed.headRefOid?.startsWith(reviewedCommit) && noFindings);
        });
    }
    if (login.includes('coderabbit')) {
        return (parsed.statusCheckRollup ?? []).some((check) => {
            const name = `${check.name ?? ''} ${check.context ?? ''}`.toLowerCase();
            const result = String(check.conclusion ?? check.state ?? '').toUpperCase();
            return name.includes('coderabbit') && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(result);
        });
    }
    return false;
}
function normalizeReviewerLogin(login) {
    return (login ?? 'automated reviewer').toLowerCase().replace(/\[bot\]$/, '');
}
function commentAuditBlockers(parsed) {
    if (parsed.state === 'MERGED')
        return [];
    return (parsed.comments ?? []).flatMap((comment) => {
        const login = normalizeReviewerLogin(comment.author?.login);
        const body = comment.body ?? '';
        if (login === 'coderabbitai' && /<!-- This is an auto-generated comment: (?:summarize|rate limited) by coderabbit\.ai -->/i.test(body)) {
            return [];
        }
        if (login === 'chatgpt-codex-connector' && hasCurrentHeadBotEvidence(login, parsed))
            return [];
        return [`PR comment ${comment.id ?? '(unknown id)'} by ${login} requires Guardian audit`];
    });
}
function mergeabilityBlockers(state) {
    const blockers = [];
    if (state.state === 'MERGED')
        return blockers;
    if (state.state && state.state !== 'OPEN')
        blockers.push(`PR state is ${state.state}`);
    if (state.isDraft)
        blockers.push('PR is draft');
    if (state.mergeable && state.mergeable !== 'MERGEABLE')
        blockers.push(`mergeable is ${state.mergeable}`);
    if (!isCleanMergeState(state.mergeStateStatus))
        blockers.push(`mergeStateStatus is ${state.mergeStateStatus ?? 'unknown'}`);
    if (state.reviewDecision === 'CHANGES_REQUESTED')
        blockers.push('reviewDecision is CHANGES_REQUESTED');
    for (const check of state.checks.filter((item) => !isPassingCheck(item))) {
        blockers.push(`check ${check.name} is ${check.status}${check.conclusion ? `/${check.conclusion}` : ''}`);
    }
    return blockers;
}
function isCleanMergeState(value) {
    return value === 'CLEAN' || value === 'HAS_HOOKS' || value === 'UNSTABLE';
}
const PASSING_CHECK_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
function isPassingCheck(check) {
    if (check.conclusion !== undefined)
        return check.status === 'COMPLETED' && PASSING_CHECK_CONCLUSIONS.has(check.conclusion);
    return check.status === 'SUCCESS';
}
async function waitForStablePrGate(runCommand, req, initial) {
    const settleMs = req.config.guardian.reviewSettleSeconds * 1_000;
    if (settleMs > 0)
        await sleep(boundedTimeoutMs(settleMs, req.runDeadlineAt));
    const first = await inspectPrGate(runCommand, req);
    if (!first.isReady)
        return first;
    if (first.headRefOid !== initial.headRefOid) {
        return { ...first, isReady: false, blockers: ['PR head changed during stabilization'] };
    }
    if (settleMs > 0)
        await sleep(boundedTimeoutMs(settleMs, req.runDeadlineAt));
    const second = await inspectPrGate(runCommand, req);
    if (!second.isReady)
        return second;
    if (second.headRefOid !== first.headRefOid || second.activityFingerprint !== first.activityFingerprint) {
        return { ...second, isReady: false, blockers: ['PR activity changed during stabilization'] };
    }
    return second;
}
async function waitForInitiallyReadyPrGate(runCommand, req, initial) {
    const settleMs = req.config.guardian.reviewSettleSeconds * 1_000;
    if (settleMs <= 0)
        return initial;
    await sleep(boundedTimeoutMs(settleMs, req.runDeadlineAt));
    const gate = await inspectPrGate(runCommand, req);
    if (!gate.isReady)
        return gate;
    return waitForStablePrGate(runCommand, req, gate);
}
async function finishAfterGuardianCommandFailure(runCommand, req, rawOutputs, startMs, failureSummary) {
    const reconciled = await reconcileReadyPrGate(runCommand, req, rawOutputs);
    return {
        status: reconciled ? 'success' : 'failed',
        summary: reconciled ? successSummary(reconciled) : failureSummary,
        raw: rawOutputs.join('\n'),
        durationMs: Date.now() - startMs
    };
}
async function reconcileReadyPrGate(runCommand, req, rawOutputs) {
    try {
        const gate = await inspectPrGate(runCommand, req);
        if (!gate.isReady) {
            rawOutputs.push(`PR remained blocked after guardian command failure:\n${summarizeGate(gate)}`);
            return undefined;
        }
        const stable = await waitForStablePrGate(runCommand, req, gate);
        if (!stable.isReady) {
            rawOutputs.push(`PR was not stably merge-ready after guardian command failure:\n${summarizeGate(stable)}`);
            return undefined;
        }
        return stable;
    }
    catch (error) {
        rawOutputs.push(`Could not reconcile PR state after guardian command failure: ${String(error)}`);
        return undefined;
    }
}
function boundedTimeoutMs(configuredTimeoutMs, runDeadlineAt) {
    if (!runDeadlineAt)
        return configuredTimeoutMs;
    const remainingMs = runDeadlineAt - Date.now();
    if (remainingMs <= 0)
        throw new Error('Kaizen run timeout exceeded.');
    return Math.min(configuredTimeoutMs, remainingMs);
}
function summarizeReviewThreads(threads) {
    return threads
        .map((thread) => {
        const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
        const author = thread.author ? ` by ${thread.author}` : '';
        const body = thread.body?.trim().split('\n')[0];
        return `- ${location}${author}${body ? ` - ${body}` : ''}`;
    })
        .join('\n');
}
function summarizeGate(gate) {
    const blockers = gate.blockers.length ? gate.blockers.map((blocker) => `- ${blocker}`).join('\n') : '- none';
    const checks = gate.checks.length
        ? gate.checks.map((check) => `- ${check.name}: ${check.status}${check.conclusion ? `/${check.conclusion}` : ''}`).join('\n')
        : '- none reported';
    return [
        `mergeable=${gate.mergeable ?? 'unknown'}`,
        `mergeStateStatus=${gate.mergeStateStatus ?? 'unknown'}`,
        `reviewDecision=${gate.reviewDecision ?? 'unknown'}`,
        'Blockers:',
        blockers,
        'Checks:',
        checks
    ].join('\n');
}
function successSummary(gate) {
    if (gate.state === 'MERGED')
        return 'PR guardian completed; PR is merged.';
    return `PR guardian completed; PR is merge-ready (${gate.mergeStateStatus ?? 'unknown'}) with passing checks and no unresolved review threads.`;
}
function buildPrompt(req, attempt) {
    return `Use the vendored PR Guardian skill at skills/pr-guardian/SKILL.md.

Monitor this pull request until it is mergeable or a real blocker remains:
- Repository: ${req.repo}
- PR: ${req.prUrl}
- PR number: ${req.prNumber}
- Branch: ${req.branch}
- Base branch: ${req.baseBranch}
- Retry budget: ${req.config.guardian.maxAttempts}
- Guardian pass: ${attempt}/${req.config.guardian.maxAttempts}

Requirements:
- Read and follow skills/pr-guardian/SKILL.md.
- This is an isolated worktree pinned to the recorded PR head. Before every push, compare GitHub headRefOid with the worktree's initial HEAD and stop without pushing if it changed; push only HEAD to the explicit remote branch ${req.branch}, without force.
- Check the PR with gh pr view and gh pr checks.
- Watch relevant workflow runs with gh run watch --exit-status when a run exists.
- Always inspect PR review feedback before declaring the PR ready to merge. Do not require reviewDecision=APPROVED or human approval unless GitHub branch protection explicitly requires it.
- Fetch inline review threads and PR comments with resolution state using paginated GraphQL/API reads, iterating until hasNextPage=false, for example via PullRequest.reviewThreads, so unresolved actionable feedback cannot be missed.
- Fetch review commit evidence from the paginated REST pulls/${req.prNumber}/reviews endpoint and compare commit_id with the pinned head; gh pr view review objects are not current-head evidence.
- Address every unresolved actionable review thread, PR comment, and check annotation with focused commits or an explicit disposition, then push any fixes. If you can resolve an addressed review thread, resolve it after replying with the disposition.
- Reply in the same review thread or comment for each addressed review item with the action taken and validation run before resolving it. If GitHub does not support a threaded reply for that item, add a PR comment that links to the original comment or review and lists the action taken.
- Stop only when GitHub reports the PR as fully mergeable: mergeable=MERGEABLE, mergeStateStatus=CLEAN, HAS_HOOKS, or UNSTABLE with only documented non-required failures, required checks are passing, and no unresolved review threads or actionable PR comments remain. If branch protection requires conversation resolution, outdated unresolved threads still block merging until they are replied to and resolved. A missing approval or reviewDecision other than APPROVED is not a blocker by itself; inspect comments again after every pushed fix.
- Re-check the PR state during every wait. If GitHub reports state=MERGED, stop all watches immediately and exit successfully so the parent guardian can reap this worker. A merged PR is a terminal success even if review threads remain unresolved; do not keep waiting or editing after merge.
- Do not merge the PR.
- Before finishing, comment on the PR with final mergeability, watched runs, fixes pushed, feedback addressed, unresolved/skipped feedback with reasons, and remaining blockers.`;
}
//# sourceMappingURL=prGuardian.js.map