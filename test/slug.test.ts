import { describe, expect, it } from 'vitest';
import { isProjectSlug, repoFromRemote, slugFromRepo } from '../src/utils/slug.js';

describe('repoFromRemote', () => {
  it('accepts GitHub repos with dots in the repository name', () => {
    expect(repoFromRemote('https://github.com/kaizen-agents-org/.github.git')).toBe('kaizen-agents-org/.github');
    expect(repoFromRemote('git@github.com:kaizen-agents-org/.github.git')).toBe('kaizen-agents-org/.github');
  });
});

describe('slugFromRepo', () => {
  it('keeps dot-prefixed repo names addressable', () => {
    expect(slugFromRepo('kaizen-agents-org/.github')).toBe('kaizen-agents-org-.github');
  });
});

describe('isProjectSlug', () => {
  it('accepts generated repository slugs and rejects path-like values', () => {
    expect(isProjectSlug('kaizen-agents-org-.github')).toBe(true);
    expect(isProjectSlug('owner-repo_1.2')).toBe(true);
    expect(isProjectSlug('..')).toBe(false);
    expect(isProjectSlug('owner/escape')).toBe(false);
    expect(isProjectSlug('owner\\escape')).toBe(false);
    expect(isProjectSlug('owner-..-escape')).toBe(false);
    expect(isProjectSlug('owner repo')).toBe(false);
  });
});
