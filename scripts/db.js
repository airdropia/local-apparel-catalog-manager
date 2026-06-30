/**
 * scripts/db.js — Catalog database layer
 *
 * Provides atomic, schema-validated read/write access to database/catalog.json.
 * Supports:
 *   - Append a new catalog entry (run)
 *   - List all entries
 *   - Search by name, category, gender, season, price range
 *   - Validate schema
 *   - Export to CSV
 *
 * Usage:
 *   node scripts/db.js append   --file <path-to-run-result.json>
 *   node scripts/db.js list
 *   node scripts/db.js search --gender male --season summer
 *   node scripts/db.js validate
 *   node scripts/db.js export --format csv --output ./catalog.csv
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { logger, atomicWriteJson, safeReadJson, slugify } = require('./utils');

const DB_PATH = path.join(__dirname, '..', 'database', 'catalog.json');

// ─── SCHEMA ─────────────────────────────────────────────────────────────────
const REQUIRED_FIELDS = ['id', 'name', 'price', 'scrapedAt'];
const SCHEMA_VERSION = '2.0.0';

function validateEntry(entry) {
  const errors = [];
  for (const f of REQUIRED_FIELDS) {
    if (!(f in entry)) errors.push(`missing field: ${f}`);
  }
  if (entry.price && typeof entry.price === 'object') {
    if (!entry.price.currency) errors.push('price.currency missing');
    if (entry.price.value !== null && typeof entry.price.value !== 'number') {
      errors.push('price.value must be number or null');
    }
  }
  return errors;
}

// ─── LOAD ───────────────────────────────────────────────────────────────────
function loadCatalog() {
  if (!fs.existsSync(DB_PATH)) {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), totalRuns: 0, entries: [] };
  }
  const data = safeReadJson(DB_PATH, null);
  if (!data) {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), totalRuns: 0, entries: [] };
  }
  if (!data.entries) data.entries = [];
  return data;
}

// ─── SAVE ───────────────────────────────────────────────────────────────────
function saveCatalog(catalog) {
  catalog.updatedAt = new Date().toISOString();
  catalog.totalRuns = catalog.entries?.length || 0;
  atomicWriteJson(DB_PATH, catalog);
}

// ─── APPEND ─────────────────────────────────────────────────────────────────
function appendRun(runResult) {
  const catalog = loadCatalog();
  const runId = runResult.runId || uuidv4();
  const entry = {
    runId,
    timestamp: runResult.scrapedAt || new Date().toISOString(),
    mode: runResult.mode || (runResult.platform === 'manual' ? 'manual' : 'link'),
    sourceUrl: runResult.sourceUrl || null,
    platform: runResult.platform || null,
    deliveryNote: runResult.deliveryNote || null,
    productCount: runResult.products?.length || 0,
    products: runResult.products,
  };

  // Validate all products
  for (const p of entry.products) {
    const errs = validateEntry(p);
    if (errs.length) logger.warn('Validation issues for product', { id: p.id, errs });
  }

  catalog.entries.push(entry);
  saveCatalog(catalog);
  logger.info('Appended catalog run', { runId, products: entry.productCount, total: catalog.totalRuns });
  return entry;
}

// ─── LIST ───────────────────────────────────────────────────────────────────
function listAll() {
  const catalog = loadCatalog();
  return catalog.entries.map(e => ({
    runId: e.runId,
    timestamp: e.timestamp,
    mode: e.mode,
    sourceUrl: e.sourceUrl,
    productCount: e.productCount,
  }));
}

// ─── SEARCH ─────────────────────────────────────────────────────────────────
function search({ name, category, gender, season, minPrice, maxPrice, mode }) {
  const catalog = loadCatalog();
  const results = [];
  for (const entry of catalog.entries) {
    for (const p of entry.products || []) {
      const matches = [];
      if (name && !p.name?.toLowerCase().includes(name.toLowerCase())) matches.push(false);
      if (category && p.category !== category) matches.push(false);
      if (gender && p.specs?.gender !== gender) matches.push(false);
      if (season && p.specs?.season !== season) matches.push(false);
      if (minPrice && (p.price?.value || 0) < minPrice) matches.push(false);
      if (maxPrice && (p.price?.value || 0) > maxPrice) matches.push(false);
      if (mode && entry.mode !== mode) matches.push(false);
      if (matches.length === 0) {
        results.push({ ...p, runId: entry.runId, runTimestamp: entry.timestamp });
      }
    }
  }
  return results;
}

// ─── EXPORT CSV ─────────────────────────────────────────────────────────────
function exportCsv(outputPath) {
  const catalog = loadCatalog();
  const headers = ['runId', 'timestamp', 'mode', 'sourceUrl', 'productName', 'sku', 'price', 'currency', 'fabric', 'color', 'gender', 'season', 'imageCount'];
  const rows = [headers.join(',')];
  for (const e of catalog.entries) {
    for (const p of e.products || []) {
      rows.push([
        e.runId,
        e.timestamp,
        e.mode,
        `"${(e.sourceUrl || '').replace(/"/g, '""')}"`,
        `"${(p.name || '').replace(/"/g, '""')}"`,
        p.sku || '',
        p.price?.value || '',
        p.price?.currency || 'PKR',
        p.specs?.fabric || '',
        p.specs?.color || '',
        p.specs?.gender || '',
        p.specs?.season || '',
        (p.images?.length || 0),
      ].join(','));
    }
  }
  fs.writeFileSync(outputPath, rows.join('\n'));
  logger.info('CSV exported', { path: outputPath, rows: rows.length - 1 });
}

// ─── VALIDATE ───────────────────────────────────────────────────────────────
function validateAll() {
  const catalog = loadCatalog();
  let totalErrors = 0;
  let totalProducts = 0;
  for (const e of catalog.entries) {
    for (const p of e.products || []) {
      totalProducts++;
      const errs = validateEntry(p);
      if (errs.length) {
        totalErrors += errs.length;
        logger.warn('Validation error', { id: p.id, name: p.name, errs });
      }
    }
  }
  logger.info('Validation complete', { totalProducts, totalErrors });
  return { totalProducts, totalErrors };
}

// ─── CLI ────────────────────────────────────────────────────────────────────
function cli() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'append': {
      const fileIdx = args.indexOf('--file');
      if (fileIdx === -1) {
        logger.error('Usage: db.js append --file <path>');
        process.exit(1);
      }
      const file = args[fileIdx + 1];
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entry = appendRun(data);
      console.log(JSON.stringify({ ok: true, runId: entry.runId }, null, 2));
      break;
    }
    case 'list': {
      const items = listAll();
      console.log(JSON.stringify(items, null, 2));
      break;
    }
    case 'search': {
      const opts = {};
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i].replace(/^--/, '');
        let val = args[i + 1];
        if (['minPrice', 'maxPrice'].includes(key)) val = parseFloat(val);
        opts[key] = val;
      }
      const results = search(opts);
      console.log(JSON.stringify(results, null, 2));
      break;
    }
    case 'validate': {
      const result = validateAll();
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'export': {
      const formatIdx = args.indexOf('--format');
      const outIdx = args.indexOf('--output');
      const format = formatIdx !== -1 ? args[formatIdx + 1] : 'csv';
      const out = outIdx !== -1 ? args[outIdx + 1] : './catalog.csv';
      if (format === 'csv') exportCsv(out);
      else logger.error('Unsupported format. Use: csv');
      break;
    }
    default:
      console.log('Usage: db.js <append|list|search|validate|export> [options]');
      process.exit(1);
  }
}

if (require.main === module) cli();
module.exports = { loadCatalog, saveCatalog, appendRun, listAll, search, validateAll, exportCsv };
