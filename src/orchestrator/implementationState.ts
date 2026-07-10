import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitHubPullRequest } from '../github/types.js';

export type ImplementationPhase = 'implementing' | 'verifying' | 'publishing' | 'guardian' | 'blocked' | 'failed' | 'complete';

export interface ImplementationState {
  version: 1;
  issue: number;
  branch: string;
  phase: ImplementationPhase;
  attempt: number;
  updatedAt: string;
  lastFailure?: string;
  pr?: number;
  prUrl?: string;
}

export async function loadImplementationState(stateDir: string, issue: number): Promise<ImplementationState | undefined> {
  try {
    return JSON.parse(await fs.readFile(implementationStatePath(stateDir, issue), 'utf8')) as ImplementationState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function listImplementationStates(stateDir: string): Promise<ImplementationState[]> {
  const dir = path.join(stateDir, 'implementations');
  try {
    const files = (await fs.readdir(dir)).filter((file) => file.startsWith('issue-') && file.endsWith('.json')).sort();
    const states = await Promise.all(files.map(async (file) => {
      try {
        return JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as ImplementationState;
      } catch {
        return undefined;
      }
    }));
    return states.filter((state): state is ImplementationState => Boolean(state));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function saveImplementationState(
  stateDir: string,
  state: Omit<ImplementationState, 'version' | 'updatedAt'>
): Promise<ImplementationState> {
  const value: ImplementationState = { version: 1, ...state, updatedAt: new Date().toISOString() };
  const target = implementationStatePath(stateDir, state.issue);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, target);
  return value;
}

export function implementationStatePath(stateDir: string, issue: number): string {
  return path.join(stateDir, 'implementations', `issue-${issue}.json`);
}

export function openCheckpointStates(
  states: ImplementationState[],
  openPullRequests: GitHubPullRequest[]
): ImplementationState[] {
  const pullRequestsByNumber = new Map(openPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]));
  return states.filter((state) => {
    if (state.phase === 'complete' || !state.pr) return false;
    return pullRequestsByNumber.get(state.pr)?.headRefName === state.branch;
  });
}

export function forbiddenCheckpointPublicationReason(forbiddenFiles: string[]): string | undefined {
  return forbiddenFiles.length > 0 ? `forbidden paths changed: ${forbiddenFiles.join(', ')}` : undefined;
}
