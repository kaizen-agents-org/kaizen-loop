import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  implementationStatePath,
  loadImplementationState,
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
});
