import { describe, expect, it } from 'vitest';
import { tailLines, tailText } from '../src/utils/text.js';

describe('text helpers', () => {
  it('returns the last meaningful lines without counting a trailing newline segment', () => {
    expect(tailLines('one\ntwo\nthree\n', 2)).toBe('two\nthree');
    expect(tailLines('one\ntwo\nthree', 2)).toBe('two\nthree');
  });

  it('returns the tail of long text by character count', () => {
    expect(tailText('abcdef', 3)).toBe('def');
    expect(tailText('abc', 5)).toBe('abc');
  });
});
