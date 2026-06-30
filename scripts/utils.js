/**
 * scripts/utils.js — Shared utilities for the catalog manager
 *
 * Provides:
 *  - Logger with structured JSON output for GitHub Actions
 *  - Atomic JSON file writer (prevents catalog corruption)
 *  - Exponential backoff with jitter for HTTP retries
 *  - Concurrency-limited async mapper (p-limit wrapper)
 *  - Random User-Agent rotator (bot-detection evasion)
 *  - Slugify + sanitize helpers
 *
 * Author: Senior Architect
 * Version: 2.0.0
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const UserAgent = require('user-agents');
const pLimit = require('p-limit');

// ─── LOGGER ─────────────────────────────────────────────────────────────────
// GitHub Actions-friendly logger: writes ::debug::, ::notice::, ::warning::,
// ::error:: annotations so they show up in the Actions UI.
const logger = {
  _emit(level, msg, obj = {}) {
    const ts = new Date().toISOString();
    const line = obj && Object.keys(obj).length
      ? `${ts} [${level}] ${msg} ${JSON.stringify(obj)}`
      : `${ts} [${level}] ${msg}`;
    if (process.env.GITHUB_ACTIONS === 'true') {
      const cmd = level === 'ERROR' ? 'error'
        : level === 'WARN' ? 'warning'
        : level === 'INFO' ? 'notice'
        : 'debug';
      console.log(`::${cmd}::${msg}${Object.keys(obj).length ? ' ' + JSON.stringify(obj) : ''}`);
    } else {
      console.log(line);
    }
  },
  info(m, o)  { this._emit('INFO', m, o); },
  warn(m, o)  { this._emit('WARN', m, o); },
  error(m, o) { this._emit('ERROR', m, o); },
  debug(m, o) { this._emit('DEBUG', m, o); },
};

// ─── ATOMIC JSON WRITE ──────────────────────────────────────────────────────
// Writes JSON safely by writing to a temp file first, then renaming.
// Prevents catalog.json corruption on concurrent workflow runs or crashes.
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  return true;
}

// ─── ATOMIC JSON READ ───────────────────────────────────────────────────────
// Safe reader that returns [] / {} if file missing or corrupted.
function safeReadJson(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
    } catch (e) {
    logger.warn(`Corrupt JSON at ${filePath}, using fallback`, { err: e.message });
    // Move corrupt file aside for forensic analysis instead of clobbering
    const bak = `${filePath}.corrupt.${Date.now()}.bak`;
    try { fs.renameSync(filePath, bak); } catch (_) {}
    return fallback;
  }
}

// ─── RETRY WITH EXPONENTIAL BACKOFF + JITTER ────────────────────────────────
// Implements the AWS-recommended backoff formula:
//   sleep = min(cap, base * 2^attempt) + random(0, base/2)
async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 800,
    maxDelayMs = 8000,
    retryOn = (err) => {
      const status = err?.response?.status;
      if (!status) return true; // network errors retry
      return status === 408 || status === 429 || status >= 500;
    },
    label = 'op',
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !retryOn(err)) {
        throw err;
      }
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = Math.random() * (baseDelayMs / 2);
      const delay = Math.round(exp + jitter);
      logger.warn(`[${label}] attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${delay}ms`, {
        err: err.message,
        status: err?.response?.status,
      });
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ─── RANDOM USER-AGENT POOL ─────────────────────────────────────────────────
// Pulls realistic browser UA strings from the user-agents library and
// rotates per request to reduce bot-detection risk.
function randomUserAgent() {
  try {
    const ua = new UserAgent({ deviceCategory: 'desktop' });
    return ua.toString();
  } catch {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  }
}

// ─── CONCURRENCY MAP ────────────────────────────────────────────────────────
// Limits in-flight promises to prevent socket exhaustion on image downloads.
async function mapWithConcurrency(items, limit, mapper) {
  const lim = pLimit(limit || 4);
  return Promise.all(items.map(item => lim(() => mapper(item))));
}

// ─── SLUGIFY ────────────────────────────────────────────────────────────────
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u0600-\u06FF\s-]/g, '') // keep Arabic/Urdu range
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ─── SAFE FILENAME ──────────────────────────────────────────────────────────
function safeFilename(text, ext = 'jpg') {
  const slug = slugify(text) || 'item';
  return `${slug}.${ext}`;
}

// ─── PRICE NORMALIZER ───────────────────────────────────────────────────────
// Accepts "Rs. 2,500", "PKR 2500", "2500", "₹2500" and returns {value, currency}.
function normalizePrice(raw) {
  if (!raw) return { value: null, currency: 'PKR', display: 'N/A' };
  const str = String(raw).trim();
  const currencyMatch = str.match(/(Rs\.?|PKR|INR|\$|USD|₹|₨)/i);
  const currency = currencyMatch
    ? currencyMatch[1].toUpperCase()
        .replace(/RS\.?/, 'PKR')
        .replace('₹', 'INR')
        .replace('₨', 'PKR')
        .replace('$', 'USD')
    : 'PKR';
  // Step 1: strip currency symbols/letters (keep digits, dots, commas, spaces)
  const noSymbols = str.replace(/(Rs\.?|PKR|INR|USD|\$|₹|₨)/gi, ' ');
  // Step 2: remove thousand separators (comma between digits)
  const noThousands = noSymbols.replace(/(\d),(\d)/g, '$1$2');
  // Step 3: strip everything except digits and dot
  let numeric = noThousands.replace(/[^0-9.]/g, '');
  // Step 4: if multiple dots, keep only the first one (treat rest as thousands sep)
  const parts = numeric.split('.');
  if (parts.length > 2) {
    numeric = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
  }
  const value = numeric ? parseFloat(numeric) : null;
  return {
    value,
    currency,
    display: value ? `${currency} ${value.toLocaleString()}` : 'N/A',
  };
}

// ─── EMOJI PICKER (category-aware) ──────────────────────────────────────────
function emojiFor(category = '') {
  const c = String(category).toLowerCase();
  // Order matters: check female/kids BEFORE male (since 'ladies' contains 'ladi' not 'gent',
  // but generic words like 'suit' could match male first if male came first)
  if (/ladi|women|girl|female|kurti|saree|dress/.test(c)) return '👗';
  if (/kid|child|baby/.test(c)) return '🧒';
  if (/gent|gents|men|men's|boy|male/.test(c)) return '👔';
  if (/suit|shirt|pant|trouser|shalwar|kurta/.test(c)) return '👔';
  if (/winter|warm|jacket|coat|sweater/.test(c)) return '🧥';
  if (/summer|lawn|cotton|light/.test(c)) return '☀️';
  if (/shoe|sandal|footwear/.test(c)) return '👟';
  if (/bag|purse|accessory/.test(c)) return '👜';
  if (/price|cost|rate/.test(c)) return '💰';
  if (/delivery|ship/.test(c)) return '🚚';
  return '🛍️';
}

// ─── HASHTAG BUILDER ────────────────────────────────────────────────────────
function buildHashtags({ city = 'Narowal', category = '', season = '' }) {
  const base = ['#LocalBoutique', '#PakistanFashion', '#OnlineShopping'];
  const cityTags = [`#${city}Fashion`, `#${city}Shopping`, `#ShopIn${city}`];
  const catTags = category
    ? [`#${slugify(category).replace(/-/g, '')}`, '#ApparelCatalog']
    : [];
  const seasonTags = season ? [`#${slugify(season)}Collection`, `#${slugify(season)}Sale`] : [];
  return [...cityTags, ...catTags, ...seasonTags, ...base];
}

// ─── EXPORTS ────────────────────────────────────────────────────────────────
module.exports = {
  logger,
  atomicWriteJson,
  safeReadJson,
  withRetry,
  randomUserAgent,
  mapWithConcurrency,
  slugify,
  safeFilename,
  normalizePrice,
  emojiFor,
  buildHashtags,
};
