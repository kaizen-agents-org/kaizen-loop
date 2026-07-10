import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  implementationStatePath,
  forbiddenCheckpointPublicationReason,
  isResumableImplementationState,
  loadImplementationState,
  openCheckpointStates,
  saveImplementationState
} from '../src/orchestrator/implementationState.js';

describe('implementation state', () => {
  it('persists the branch, phase, and last failure for the next run', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-implementation-state-'));

    await saveImplementationState(stateDir, {
      issue: 42,
      branch: 'kaizen/issue-42-resume-me',
      phase: 'failed',
      attempt: 2,
      lastFailure: 'verification failed'
    });

    await expect(loadImplementationState(stateDir, 42)).resolves.toMatchObject({
      version: 1,
      issue: 42,
      branch: 'kaizen/issue-42-resume-me',
      phase: 'failed',
      attempt: 2,
      lastFailure: 'verification failed'
    });
    await expect(fs.access(implementationStatePath(stateDir, 42))).resolves.toBeUndefined();
  });

  it('returns undefined when an issue has no checkpoint', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaizen-implementation-state-'));
    await expect(loadImplementationState(stateDir, 404)).resolves.toBeUndefined();
  });

  it('exempts only checkpoints backed by their matching open pull request', () => {
    const updatedAt = new Date().toISOString();
    const states = [
      { version: 1 as const, issue: 1, branch: 'kaizen/issue-1', phase: 'failed' as const, attempt: 1, updatedAt },
      { version: 1 as const, issue: 2, branch: 'kaizen/issue-2', phase: 'failed' as const, attempt: 1, updatedAt, pr: 12 },
      { version: 1 as const, issue: 3, branch: 'kaizen/issue-3', phase: 'failed' as const, attempt: 1, updatedAt, pr: 13 },
      { version: 1 as const, issue: 4, branch: 'kaizen/issue-4', phase: 'complete' as const, attempt: 1, updatedAt, pr: 14 }
    ];

    expect(openCheckpointStates(states, [
      { number: 12, headRefName: 'kaizen/issue-2', isDraft: true, url: 'https://github.com/o/r/pull/12' },
      { number: 13, headRefName: 'different-branch', isDraft: true, url: 'https://github.com/o/r/pull/13' },
      { number: 14, headRefName: 'kaizen/issue-4', isDraft: true, url: 'https://github.com/o/r/pull/14' }
    ]).map((state) => state.issue)).toEqual([2]);
  });

  it('does not treat a ready guardian PR as a checkpoint draft', () => {
    const updatedAt = new Date().toISOString();
    const states = [{
      version: 1 as const,
      issue: 5,
      branch: 'kaizen/issue-5',
      phase: 'guardian' as const,
      attempt: 1,
      updatedAt,
      pr: 15
    }];

    expect(openCheckpointStates(states, [
      { number: 15, headRefName: 'kaizen/issue-5', isDraft: false, url: 'https://github.com/o/r/pull/15' }
    ])).toEqual([]);
  });

  it('blocks remote checkpoint publication when forbidden paths changed', () => {
    expect(forbiddenCheckpointPublicationReason(['.env', '.github/private.key'])).toBe(
      'forbidden paths changed: .env, .github/private.key'
    );
    expect(forbiddenCheckpointPublicationReason([])).toBeUndefined();
  });

  it('resumes only active implementation checkpoint phases', () => {
    const base = {
      version: 1 as const,
      issue: 1,
      branch: 'kaizen/issue-1',
      attempt: 1,
      updatedAt: new Date().toISOString()
    };
    expect(isResumableImplementationState({ ...base, phase: 'failed' })).toBe(true);
    expect(isResumableImplementationState({ ...base, phase: 'blocked' })).toBe(true);
    expect(isResumableImplementationState({ ...base, phase: 'guardian' })).toBe(false);
    expect(isResumableImplementationState({ ...base, phase: 'discarded' })).toBe(false);
    expect(isResumableImplementationState({ ...base, phase: 'recovery-needed' })).toBe(true);
    expect(isResumableImplementationState({ ...base, phase: 'complete' })).toBe(false);
    expect(isResumableImplementationState(undefined)).toBe(false);
  });
});
