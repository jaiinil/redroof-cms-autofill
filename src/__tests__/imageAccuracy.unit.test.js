import { describe, test, expect } from '@jest/globals';
import { extractFileName, matchAgainst, similarity, asArray } from '../verifyImageAccuracy.js';

// Fast, no network - validates the comparison logic itself against fixed
// examples pulled from real CMS/reference payloads seen in this project.

describe('extractFileName', () => {
  test('reads the DAM alias from OriginalImagePath, not the display-name ResourceFile', () => {
    const img = {
      ResourceFile: '207-2 full beds 3.jpg', // display name (spaces) - must NOT be preferred
      OriginalImagePath: 'https://assets.milestoneinternet.com/red-roof/rri207/siteimages/207-2-full-beds-3.jpg',
    };
    expect(extractFileName(img)).toBe('207-2-full-beds-3.jpg');
  });

  test('falls back to ResourceFile when OriginalImagePath is absent', () => {
    expect(extractFileName({ ResourceFile: 'placeholder-image-1.jpg' })).toBe('placeholder-image-1.jpg');
  });

  test('returns null for a missing/empty image', () => {
    expect(extractFileName(null)).toBeNull();
    expect(extractFileName(undefined)).toBeNull();
  });

  test('strips a query string off the URL', () => {
    const img = { OriginalImagePath: 'https://assets.milestoneinternet.com/red-roof/rri207/siteimages/207-exterior-3.jpg?width=403&height=250' };
    expect(extractFileName(img)).toBe('207-exterior-3.jpg');
  });
});

describe('matchAgainst', () => {
  test('exact (case-insensitive) filename match', () => {
    const r = matchAgainst('207-Exterior-3.jpg', ['207-exterior-3.jpg']);
    expect(r.result).toBe('exact');
  });

  test('no image set at all', () => {
    expect(matchAgainst(null, ['207-exterior-3.jpg']).result).toBe('no-image');
  });

  test('a genuinely unrelated filename is a mismatch, not a fuzzy pass', () => {
    const r = matchAgainst('the-stylish-lobby-of-hotel-ardent-in-dayton-oh-features-contemporary-decor.jpg', ['207-exterior-3.jpg']);
    expect(r.result).toBe('mismatch');
  });

  test('a close-but-not-identical filename (drifted naming) still traces via fuzzy match', () => {
    const r = matchAgainst('207-superior-king-two.jpg', ['207-superior-king-2.jpg']);
    // token overlap is high (207/superior/king shared) even though "two" != "2"
    expect(['fuzzy', 'exact']).toContain(r.result);
  });

  test('empty expected-name list is always a mismatch, never a false pass', () => {
    expect(matchAgainst('207-exterior-3.jpg', []).result).toBe('mismatch');
    expect(matchAgainst('207-exterior-3.jpg', [null, undefined]).result).toBe('mismatch');
  });
});

describe('asArray', () => {
  test('passes a real array through unchanged', () => {
    expect(asArray([{ a: 1 }])).toEqual([{ a: 1 }]);
  });

  test('parses the literal string "[]" as an empty array (real CMS bug, RRI1280/RRI1397)', () => {
    expect(asArray('[]')).toEqual([]);
  });

  test('parses a JSON-array-shaped string', () => {
    expect(asArray('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  test('null/undefined/garbage all become an empty array, never throw', () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray('not json')).toEqual([]);
    expect(asArray(42)).toEqual([]);
  });
});

describe('similarity', () => {
  test('identical strings score 1', () => {
    expect(similarity('a.jpg', 'a.jpg')).toBe(1);
  });

  test('completely disjoint strings score 0', () => {
    expect(similarity('207-exterior.jpg', '656-lobby.jpg')).toBe(0);
  });
});
