import { loadConfig } from '../config/config.js';
import { resolveProject } from '../config/registry.js';
import { GitHubClient } from '../github/client.js';
import { enqueueManagedPrGuardianJobs, enqueuePrGuardianJob, findPrGuardianJob, listPrGuardianJobs, runPendingPrGuardianJobs, runPrGuardianJob } from '../orchestrator/prGuardian.js';
import { RunLock } from '../orchestrator/lock.js';
import { KaizenError } from '../utils/errors.js';
import { projectStateDir } from '../utils/paths.js';
import { ensurePrivateProjectStateDirectory } from '../utils/workspaceTrust.js';
export async function listGuardianJobs(options) {
    const resolved = await resolveProject(options.project, options.cwd);
    return { jobs: await listPrGuardianJobs(projectStateDir(resolved.slug)) };
}
export async function runGuardianForPullRequest(options) {
    const resolved = await resolveProject(options.project, options.cwd);
    const config = await loadConfig(resolved.project.localPath);
    const stateDir = projectStateDir(resolved.slug);
    await ensurePrivateProjectStateDirectory(stateDir);
    const lock = await RunLock.acquire(stateDir);
    try {
        const github = new GitHubClient(options.runCommand, resolved.project.localPath);
        const current = await github.getPullRequest(options.pr);
        let job = await findPrGuardianJob(stateDir, options.pr);
        if (!job || job.headSha !== current.headRefOid) {
            job = await enqueuePrGuardianJob({
                stateDir,
                config,
                repo: resolved.project.repo,
                prUrl: current.url,
                prNumber: current.number,
                branch: current.headRefName ?? job?.branch ?? `pr-${current.number}`,
                baseBranch: current.baseRefName,
                headSha: current.headRefOid
            });
        }
        return await runPrGuardianJob({
            stateDir,
            config,
            workspaceDir: resolved.project.workspacePath,
            runCommand: options.runCommand,
            job,
            isolateWorktree: true
        });
    }
    finally {
        await lock.release();
    }
}
export async function watchGuardianJobs(options) {
    const resolved = await resolveProject(options.project, options.cwd);
    const config = await loadConfig(resolved.project.localPath);
    if (!config.guardian.enabled)
        throw new KaizenError('PR guardian is disabled for this project.', 2);
    const stateDir = projectStateDir(resolved.slug);
    await ensurePrivateProjectStateDirectory(stateDir);
    const lock = await RunLock.acquire(stateDir);
    try {
        const github = new GitHubClient(options.runCommand, resolved.project.localPath);
        await enqueueManagedPrGuardianJobs({
            stateDir,
            config,
            repo: resolved.project.repo,
            pullRequests: await github.listAllOpenPullRequests()
        });
        return {
            jobs: await runPendingPrGuardianJobs({
                stateDir,
                config,
                workspaceDir: resolved.project.workspacePath,
                runCommand: options.runCommand,
                isolateWorktree: true
            })
        };
    }
    finally {
        await lock.release();
    }
}
//# sourceMappingURL=guardian.js.map