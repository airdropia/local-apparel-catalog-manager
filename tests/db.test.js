/**
 * tests/db.test.js — Unit tests for the catalog database layer
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Override DB_PATH by setting process.env before requiring
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
const tmpDb = path.join(tmpDir, 'catalog.json');

// Mock the DB_PATH in db.js
jest.mock('../scripts/utils', () => {
  const actual = jest.requireActual('../scripts/utils');
  return { ...actual };
});

// Re-require db with a fresh module path so we can intercept DB_PATH
// We need to monkey-patch path.join — easier: copy db.js logic into test
// Instead, we'll test the public functions against the real DB_PATH but
// back it up first.

const db = require('../scripts/db.js');
const realDbPath = path.join(__dirname, '..', 'database', 'catalog.json');

let backup;
beforeAll(() => {
  if (fs.existsSync(realDbPath)) {
    backup = fs.readFileSync(realDbPath, 'utf8');
  }
});

afterAll(() => {
  if (backup !== undefined) {
    fs.writeFileSync(realDbPath, backup, 'utf8');
  } else if (fs.existsSync(realDbPath)) {
    fs.unlinkSync(realDbPath);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sampleRun = {
  runId: 'test-run-1',
  scrapedAt: '2026-06-30T00:00:00.000Z',
  mode: 'manual',
  sourceUrl: null,
  platform: 'manual',
  deliveryNote: 'Free delivery in Narowal',
  productCount: 1,
  products: [{
    id: 'p1',
    name: 'Test Gents Suit',
    sku: 'TEST-1',
    price: { value: 2500, currency: 'PKR', display: 'PKR 2,500' },
    images: [],
    localImages: [],
    description: 'A test product',
    specs: {
      fabric: 'cotton',
      color: 'blue',
      gender: 'male',
      season: 'summer',
      pieces: 2,
      components: 'shirt, trouser',
    },
    scrapedAt: '2026-06-30T00:00:00.000Z',
  }],
};

describe('catalog DB', () => {
  test('appendRun adds an entry', () => {
    // Start fresh
    fs.writeFileSync(realDbPath, JSON.stringify({
      schemaVersion: '2.0.0', updatedAt: '', totalRuns: 0, entries: [],
    }));
    const entry = db.appendRun(sampleRun);
    expect(entry.runId).toBe('test-run-1');
    expect(entry.products.length).toBe(1);

    const catalog = db.loadCatalog();
    expect(catalog.entries.length).toBe(1);
    expect(catalog.totalRuns).toBe(1);
  });

  test('listAll returns summary', () => {
    const items = db.listAll();
    expect(items.length).toBe(1);
    expect(items[0].runId).toBe('test-run-1');
  });

  test('search by gender finds product', () => {
    const results = db.search({ gender: 'male' });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Test Gents Suit');
  });

  test('search by gender returns empty for mismatch', () => {
    const results = db.search({ gender: 'female' });
    expect(results.length).toBe(0);
  });

  test('search by minPrice filters correctly', () => {
    expect(db.search({ minPrice: 2000 }).length).toBe(1);
    expect(db.search({ minPrice: 3000 }).length).toBe(0);
  });

  test('validateAll returns zero errors on well-formed data', () => {
    const result = db.validateAll();
    expect(result.totalProducts).toBe(1);
    expect(result.totalErrors).toBe(0);
  });

  test('exportCsv writes CSV file', () => {
    const csvPath = path.join(tmpDir, 'export.csv');
    db.exportCsv(csvPath);
    const content = fs.readFileSync(csvPath, 'utf8');
    expect(content).toContain('runId,timestamp,mode');
    expect(content).toContain('Test Gents Suit');
  });
});
