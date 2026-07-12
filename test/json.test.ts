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
});
