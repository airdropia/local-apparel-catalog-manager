/**
 * tests/utils.test.js — Unit tests for utility functions
 */

const {
  slugify,
  safeFilename,
  normalizePrice,
  emojiFor,
  buildHashtags,
  atomicWriteJson,
  safeReadJson,
} = require('../scripts/utils');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('slugify', () => {
  test('lowercases and hyphenates', () => {
    expect(slugify('Gents Wash n Wear Suit')).toBe('gents-wash-n-wear-suit');
  });
  test('strips special chars but keeps urdu', () => {
    expect(slugify('کرتا شلوار!!!')).toBe('کرتا-شلوار');
  });
  test('handles empty', () => {
    expect(slugify('')).toBe('');
  });
  test('truncates long strings', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBe(80);
  });
});

describe('safeFilename', () => {
  test('returns slugified name with extension', () => {
    expect(safeFilename('Premium Suit!!!', 'jpg')).toBe('premium-suit.jpg');
  });
  test('defaults to item when slug is empty', () => {
    expect(safeFilename('!!!', 'jpg')).toBe('item.jpg');
  });
});

describe('normalizePrice', () => {
  test('parses Rs. 2,500', () => {
    expect(normalizePrice('Rs. 2,500')).toEqual({
      value: 2500, currency: 'PKR', display: 'PKR 2,500',
    });
  });
  test('parses PKR 2500', () => {
    expect(normalizePrice('PKR 2500').value).toBe(2500);
    expect(normalizePrice('PKR 2500').currency).toBe('PKR');
  });
  test('parses bare number', () => {
    expect(normalizePrice('2500').value).toBe(2500);
    expect(normalizePrice('2500').currency).toBe('PKR');
  });
  test('parses INR', () => {
    expect(normalizePrice('₹ 1500').currency).toBe('INR');
  });
  test('parses USD', () => {
    expect(normalizePrice('$25').currency).toBe('USD');
    expect(normalizePrice('$25').value).toBe(25);
  });
  test('handles null', () => {
    expect(normalizePrice(null).value).toBeNull();
    expect(normalizePrice(null).display).toBe('N/A');
  });
});

describe('emojiFor', () => {
  test('returns necktie for gents', () => {
    expect(emojiFor('gents suit')).toBe('👔');
  });
  test('returns dress for ladies', () => {
    expect(emojiFor('ladies lawn suit')).toBe('👗');
  });
  test('returns default for unknown', () => {
    expect(emojiFor('')).toBe('🛍️');
  });
  test('returns jacket for winter', () => {
    expect(emojiFor('winter jacket')).toBe('🧥');
  });
});

describe('buildHashtags', () => {
  test('includes city hashtags', () => {
    const tags = buildHashtags({ city: 'Narowal', category: 'Suit', season: 'summer' });
    expect(tags).toContain('#NarowalFashion');
    expect(tags).toContain('#NarowalShopping');
  });
  test('includes season tags when season provided', () => {
    const tags = buildHashtags({ city: 'Lahore', season: 'winter' });
    expect(tags.some(t => t.toLowerCase().includes('winter'))).toBe(true);
  });
});

describe('atomicWriteJson + safeReadJson', () => {
  let tmpFile;
  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `test-${Date.now()}.json`);
  });
  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  test('round-trips JSON data', () => {
    const data = { foo: 'bar', n: 42, arr: [1, 2, 3] };
    atomicWriteJson(tmpFile, data);
    const read = safeReadJson(tmpFile);
    expect(read).toEqual(data);
  });

  test('safeReadJson returns fallback for missing file', () => {
    const fallback = { default: true };
    expect(safeReadJson('/nonexistent/path.json', fallback)).toEqual(fallback);
  });

  test('safeReadJson returns fallback for corrupt JSON', () => {
    fs.writeFileSync(tmpFile, '{ not valid json !!!');
    const fallback = { recovered: true };
    const result = safeReadJson(tmpFile, fallback);
    expect(result).toEqual(fallback);
  });
});
