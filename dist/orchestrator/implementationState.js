import fs from 'node:fs/promises';
import path from 'node:path';
export async function loadImplementationState(stateDir, issue) {
    try {
        return JSON.parse(await fs.readFile(implementationStatePath(stateDir, issue), 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
export async function listImplementationStates(stateDir) {
    const dir = path.join(stateDir, 'implementations');
    try {
        const files = (await fs.readdir(dir)).filter((file) => file.startsWith('issue-') && file.endsWith('.json')).sort();
        const states = await Promise.all(files.map(async (file) => {
            try {
                return JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
            }
            catch {
                return undefined;
            }
        }));
        return states.filter((state) => Boolean(state));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}
export async function saveImplementationState(stateDir, state) {
    const value = { version: 1, ...state, updatedAt: new Date().toISOString() };
    const target = implementationStatePath(stateDir, state.issue);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(temporary, target);
    return value;
}
export function implementationStatePath(stateDir, issue) {
    return path.join(stateDir, 'implementations', `issue-${issue}.json`);
}
export function openCheckpointStates(states, openPullRequests) {
    const pullRequestsByNumber = new Map(openPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]));
    return states.filter((state) => {
        if (state.phase === 'complete' || !state.pr)
            return false;
        const pullRequest = pullRequestsByNumber.get(state.pr);
        return pullRequest?.isDraft === true && pullRequest.headRefName === state.branch;
    });
}
export function forbiddenCheckpointPublicationReason(forbiddenFiles) {
    return forbiddenFiles.length > 0 ? `forbidden paths changed: ${forbiddenFiles.join(', ')}` : undefined;
}
export function isResumableImplementationState(state) {
    return Boolean(state && ['implementing', 'verifying', 'publishing', 'blocked', 'failed', 'infrastructure-failure', 'recovery-needed'].includes(state.phase));
}
//# sourceMappingURL=implementationState.js.map