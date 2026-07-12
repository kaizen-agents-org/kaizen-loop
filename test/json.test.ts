import { describe, expect, it } from 'vitest';
import { extractLastJsonObject } from '../src/utils/json.js';

describe('extractLastJsonObject', () => {
  it('extracts a nested JSON object surrounded by prose', () => {
    expect(extractLastJsonObject('Plan follows:\n{"status":"issue","nextIssue":{"title":"Concrete title"}}\nDone.')).toEqual({
      status: 'issue',
      nextIssue: { title: 'Concrete title' }
    });
  });

  it('ignores braces inside JSON strings', () => {
    expect(extractLastJsonObject('Result: {"body":"Use {value} safely","ok":true}')).toEqual({
      body: 'Use {value} safely',
      ok: true
    });
  });

  it('handles escaped quotes and backslashes inside strings', () => {
    expect(extractLastJsonObject('Text {"key":"path\\\\with\\\"quote","ok":true}')).toEqual({
      key: 'path\\with"quote',
      ok: true
    });
  });

  it('returns the last parseable object', () => {
    expect(extractLastJsonObject('{"first":1} middle {"second":2}')).toEqual({ second: 2 });
  });

  it('extracts fenced JSON', () => {
    expect(extractLastJsonObject('```json\n{"fenced":true}\n```')).toEqual({ fenced: true });
  });

  it('finds JSON after unmatched opening braces', () => {
    expect(extractLastJsonObject(`${'{'.repeat(1000)} prose {"ok":true}`)).toEqual({ ok: true });
  });

  it('throws when no JSON object is parseable', () => {
    expect(() => extractLastJsonObject('no json here')).toThrow('No parseable JSON object found');
  });
});
