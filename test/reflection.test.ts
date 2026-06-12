import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { decideReflection } from '../src/orchestrator/reflection.js';

const baseDiff = {
  files: ['src/a.ts'],
  changedFiles: 1,
  changedLines: 10,
  forbiddenFiles: [],
  protectedFiles: []
};

describe('decideReflection', () => {
  it('forces PR when verification is not configured', () => {
    const decision = decideReflection({
      config: configSchema.parse({ version: 1 }),
      labels: ['kaizen'],
      diff: baseDiff,
      verifyConfigured: false
    });

    expect(decision.action).toBe('pr');
  });

  it('uses direct commits for small verified hybrid changes', () => {
    const decision = decideReflection({
      config: configSchema.parse({ version: 1, policy: { mode: 'hybrid' } }),
      labels: ['kaizen'],
      diff: baseDiff,
      verifyConfigured: true
    });

    expect(decision.action).toBe('direct');
  });

  it('respects pr-only labels and protected paths', () => {
    expect(
      decideReflection({
        config: configSchema.parse({ version: 1 }),
        labels: ['kaizen', 'kaizen:pr-only'],
        diff: baseDiff,
        verifyConfigured: true
      }).action
    ).toBe('pr');
    expect(
      decideReflection({
        config: configSchema.parse({ version: 1 }),
        labels: ['kaizen'],
        diff: { ...baseDiff, protectedFiles: ['.github/workflows/ci.yml'] },
        verifyConfigured: true
      }).action
    ).toBe('pr');
  });
});
