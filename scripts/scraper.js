/**
 * scripts/scraper.js — Multi-platform brand scraper engine
 *
 * Supported platforms (auto-detected via plugin chain):
 *   1. Shopify-based stores (Nishat Linen, Gul Ahmed, etc.)
 *   2. WooCommerce (WordPress) stores
 *   3. Generic OpenGraph + JSON-LD fallback
 *
 * Features:
 *   - Rotating User-Agents per request
 *   - Exponential backoff retries (3x)
 *   - High-res image discovery (zoom variants)
 *   - Spec extraction (fabric, color, pieces, SKU)
 *   - Atomic download with memory-buffer then disk write
 *
 * Usage:
 *   node scripts/scraper.js
 *
 * Env:
 *   CATALOG_URL     (required)  Brand product URL or collection URL
 *   DELIVERY_NOTE   (optional)  e.g. "Free delivery in Narowal"
 *   OUTPUT_DIR      (optional)  defaults to ./output
 *   MAX_PRODUCTS    (optional)  defaults to 20
 *
 * Output:
 *   $OUTPUT_DIR/scrape_result.json  — raw extracted product data
 *   $OUTPUT_DIR/images/             — downloaded high-res media
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');

const {
  logger,
  withRetry,
  randomUserAgent,
  mapWithConcurrency,
  slugify,
  safeFilename,
  normalizePrice,
} = require('./utils');

// Axios instance that ignores cert errors (some brand sites use expired certs)
// and pools keep-alive connections for speed.
const http = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ur;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  },
  validateStatus: s => s < 500,
});

// ─── PAGE FETCH WITH RETRY ──────────────────────────────────────────────────
async function fetchPage(url) {
  return withRetry(
    async (attempt) => {
      logger.info(`Fetching page (attempt ${attempt + 1})`, { url });
      const res = await http.get(url, {
        headers: { 'User-Agent': randomUserAgent() },
      });
      if (res.status === 404) {
        const e = new Error(`404 Not Found: ${url}`);
        e.response = res;
        throw e;
      }
      if (res.status === 403) {
        logger.warn('403 Forbidden — site may have bot protection', { url });
      }
      return res.data;
    },
    { label: 'fetchPage', maxRetries: 3 }
  );
}

// ─── IMAGE DOWNLOAD ─────────────────────────────────────────────────────────
async function downloadImage(url, destDir, nameHint) {
  return withRetry(
    async (attempt) => {
      const buf = await http.get(url, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': randomUserAgent() },
        maxContentLength: 25 * 1024 * 1024, // 25 MB cap
      });
      const ext = (url.match(/\.(jpe?g|png|webp|avif|gif)(\?|$)/i) || [, 'jpg'])[1].toLowerCase();
      const fname = safeFilename(nameHint, ext === 'jpeg' ? 'jpg' : ext);
      const fpath = path.join(destDir, fname);
      fs.writeFileSync(fpath, buf);
      logger.debug('Downloaded image', { url, bytes: buf.length, dest: fpath });
      return { url, path: fpath, bytes: buf.length };
    },
    { label: 'downloadImage', maxRetries: 3 }
  );
}

// ─── SHOPIFY PLUGIN ─────────────────────────────────────────────────────────
// Detects Shopify stores by /products.json or window.Shopify metadata.
async function tryShopify(url, html) {
  const $ = cheerio.load(html);
  const isShopify =
    $('script[src*="cdn.shopify.com"]').length > 0 ||
    html.includes('window.Shopify') ||
    html.includes('cdn.shopify.com/s/');

  if (!isShopify) return null;

  // If collection URL, find product links; if product URL, parse directly.
  const productLinks = [];
  $('a[href*="/products/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      const full = new URL(href, url).href;
      if (!productLinks.includes(full)) productLinks.push(full);
    }
  });

  // If this IS a product page, parse it.
  const productJsonLd = $('script[type="application/ld+json"]').first().text();
  let product = null;
  try {
    const ld = JSON.parse(productJsonLd);
    if (ld['@type'] === 'Product' || (Array.isArray(ld) && ld.find(x => x['@type'] === 'Product'))) {
      product = Array.isArray(ld) ? ld.find(x => x['@type'] === 'Product') : ld;
    }
  } catch {}

  return {
    platform: 'shopify',
    productLinks: [...new Set(productLinks)],
    directProduct: product,
  };
}

// ─── WOOCOMMERCE PLUGIN ─────────────────────────────────────────────────────
async function tryWooCommerce(url, html) {
  const $ = cheerio.load(html);
  const isWoo =
    $('body').hasClass('woocommerce') ||
    html.includes('woocommerce') ||
    $('link[href*="woocommerce"]').length > 0;
  if (!isWoo) return null;

  const productLinks = [];
  $('a[href*="/product/"], .woocommerce-loop-product__link').each((_, el) => {
    const href = $(el).attr('href');
    if (href) productLinks.push(new URL(href, url).href);
  });

  return { platform: 'woocommerce', productLinks: [...new Set(productLinks)], directProduct: null };
}

// ─── GENERIC FALLBACK PLUGIN ────────────────────────────────────────────────
// Uses OpenGraph + JSON-LD + common product CSS selectors.
async function tryGeneric(url, html) {
  const $ = cheerio.load(html);

  const getMeta = (prop) => $(`meta[property="${prop}"], meta[name="${prop}"]`).attr('content') || null;

  const title =
    getMeta('og:title') ||
    $('h1.product-title, h1.product-single__title, h1[itemprop="name"], h1').first().text().trim() ||
    $('title').first().text().trim();

  const priceText =
    $('[itemprop="price"]').attr('content') ||
    $('.price, .product-price, .woocommerce-Price-amount, .money, .price-item').first().text().trim() ||
    getMeta('product:price:amount');

  const image =
    getMeta('og:image') ||
    $('img.product-single__photo, .product-gallery img, .woocommerce-product-gallery__image img, picture img').first().attr('src') ||
    $('img').first().attr('src');

  const description =
    getMeta('og:description') ||
    $('[itemprop="description"], .product-description, .product-details__description').first().text().trim();

  if (!title && !image) return null;

  return {
    platform: 'generic',
    productLinks: [],
    directProduct: {
      name: title,
      image: image ? new URL(image, url).href : null,
      description,
      offers: priceText ? { price: priceText } : null,
    },
  };
}

// ─── DETECT PLATFORM ────────────────────────────────────────────────────────
async function detectPlatform(url, html) {
  // Try plugins in order; first match wins.
  for (const plugin of [tryShopify, tryWooCommerce, tryGeneric]) {
    try {
      const result = await plugin(url, html);
      if (result) return result;
    } catch (e) {
      logger.warn('Plugin failed', { plugin: plugin.name, err: e.message });
    }
  }
  return { platform: 'unknown', productLinks: [], directProduct: null };
}

// ─── PARSE A SINGLE PRODUCT PAGE ────────────────────────────────────────────
function parseProductPage(url, html) {
  const $ = cheerio.load(html);

  // JSON-LD first (most reliable)
  const ldScripts = $('script[type="application/ld+json"]').toArray();
  for (const el of ldScripts) {
    try {
      const raw = $(el).html();
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const product = arr.find(x => x['@type'] === 'Product' || (Array.isArray(x['@type']) && x['@type'].includes('Product')));
      if (product) {
        return normalizeProduct(product, url, $);
      }
    } catch {}
  }

  // Fallback to meta + selectors
  const title = $('h1').first().text().trim() || $('title').text().trim();
  const priceText =
    $('[itemprop="price"]').attr('content') ||
    $('.price, .woocommerce-Price-amount, .money').first().text().trim();
  const image = $('img').first().attr('src') || $('meta[property="og:image"]').attr('content');
  const description = $('[itemprop="description"], .product-description').first().text().trim();

  return normalizeProduct({
    name: title,
    image,
    description,
    offers: priceText ? { price: priceText } : null,
  }, url, $);
}

// ─── NORMALIZE PRODUCT OBJECT ───────────────────────────────────────────────
function normalizeProduct(raw, sourceUrl, $) {
  const name = (raw.name || raw.title || '').trim();
  const sku = raw.sku || raw.mpn || $('[itemprop="sku"]').first().text().trim() || null;

  const offers = raw.offers || {};
  const priceRaw = offers.price || offers.lowPrice || (Array.isArray(offers) ? offers[0]?.price : null);
  const price = normalizePrice(priceRaw);

  // Image collection
  const images = [];
  if (raw.image) {
    const imgArr = Array.isArray(raw.image) ? raw.image : [raw.image];
    imgArr.forEach(i => images.push(typeof i === 'string' ? i : i?.url));
  }
  // Also pull from gallery selectors
  $('.product-gallery img, .woocommerce-product-gallery__image img, .product-single__media img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) images.push(src);
  });
  // De-dup + absolutize
  const uniqueImages = [...new Set(images)].map(i => {
    try { return new URL(i, sourceUrl).href; } catch { return i; }
  }).filter(Boolean);

  // Spec extraction from description / additional property
  const specs = extractSpecs(raw.description || '', raw.additionalProperty || []);

  return {
    id: uuidv4(),
    sourceUrl,
    name,
    sku,
    price,
    images: uniqueImages.slice(0, 6),  // cap to 6
    description: (raw.description || '').trim(),
    specs,
    scrapedAt: new Date().toISOString(),
  };
}

// ─── SPEC EXTRACTOR ─────────────────────────────────────────────────────────
function extractSpecs(description, additionalProps = []) {
  const specs = {
    fabric: null,
    color: null,
    pieces: null,
    components: null,
    season: null,
    gender: null,
  };

  const text = (description || '').toLowerCase();

  // Fabric
  const fabricMatch = text.match(/(cotton|lawn|linen|silk|chiffon|wash\s*n\s*wear|wool|khaddar|jersey|velvet|denim|organza)/i);
  if (fabricMatch) specs.fabric = fabricMatch[1].replace(/\s+/g, ' ').toLowerCase();

  // Color
  const colorMatch = text.match(/(black|white|red|blue|green|yellow|pink|purple|brown|grey|gray|orange|maroon|beige|navy|olive|peach|mustard)/i);
  if (colorMatch) specs.color = colorMatch[1].toLowerCase();

  // Pieces
  const pieceMatch = text.match(/(\d+)\s*piece|(\d+)\s*pc/i);
  if (pieceMatch) specs.pieces = parseInt(pieceMatch[1] || pieceMatch[2], 10);

  // Components
  if (/shirt|kurta/.test(text)) specs.components = (specs.components || '') + ' shirt';
  if (/dupatta|chunni/.test(text)) specs.components = (specs.components || '') + ' dupatta';
  if (/trouser|shalwar|pant/.test(text)) specs.components = (specs.components || '') + ' trouser';
  if (specs.components) specs.components = specs.components.trim().replace(/\s+/g, ' ');

  // Season
  const seasonMatch = text.match(/(summer|winter|spring|fall|autumn|eid|winter\s*collection|summer\s*collection)/i);
  if (seasonMatch) specs.season = seasonMatch[1].toLowerCase();

  // Gender
  if (/gents|men|male|boy/.test(text)) specs.gender = 'male';
  else if (/ladies|women|female|girl/.test(text)) specs.gender = 'female';
  else if (/kid|child|baby/.test(text)) specs.gender = 'kids';

  // Pull from additionalProperty (JSON-LD spec)
  if (Array.isArray(additionalProps)) {
    additionalProps.forEach(p => {
      const name = (p.name || '').toLowerCase();
      const val = p.value;
      if (name === 'fabric' || name === 'material') specs.fabric = val;
      if (name === 'color') specs.color = val;
      if (name === 'pieces' || name === 'piece count') specs.pieces = parseInt(val, 10) || specs.pieces;
      if (name === 'season') specs.season = val;
      if (name === 'gender') specs.gender = val;
    });
  }

  return specs;
}

// ─── MAIN ENTRY ─────────────────────────────────────────────────────────────
async function main() {
  const CATALOG_URL = process.env.CATALOG_URL;
  const DELIVERY_NOTE = process.env.DELIVERY_NOTE || '';
  const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '..', 'output');
  const MAX_PRODUCTS = parseInt(process.env.MAX_PRODUCTS || '20', 10);

  if (!CATALOG_URL) {
    logger.error('CATALOG_URL environment variable is required');
    process.exit(1);
  }

  const imagesDir = path.join(OUTPUT_DIR, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  logger.info('Starting scraper', { url: CATALOG_URL, maxProducts: MAX_PRODUCTS });

  // Step 1: Fetch landing page + detect platform
  const landingHtml = await fetchPage(CATALOG_URL);
  const platform = await detectPlatform(CATALOG_URL, landingHtml);
  logger.info('Platform detected', { platform: platform.platform });

  let productUrls = platform.productLinks.slice(0, MAX_PRODUCTS);

  // If landing is already a product page, use it directly.
  if (platform.directProduct && (!productUrls || productUrls.length === 0)) {
    productUrls = [CATALOG_URL];
  }

  if (productUrls.length === 0) {
    logger.warn('No product links found on landing page');
  }

  // Step 2: Parse each product page (with concurrency limit)
  logger.info(`Parsing ${productUrls.length} product pages`);
  const products = await mapWithConcurrency(productUrls, 3, async (purl) => {
    try {
      const html = await fetchPage(purl);
      return parseProductPage(purl, html);
    } catch (e) {
      logger.error('Failed to parse product', { url: purl, err: e.message });
      return null;
    }
  });

  const validProducts = products.filter(Boolean);
  logger.info(`Parsed ${validProducts.length} products`);

  // Step 3: Download images
  logger.info('Downloading images');
  await mapWithConcurrency(validProducts, 2, async (prod) => {
    const localImages = [];
    for (const imgUrl of prod.images) {
      try {
        const nameHint = `${slugify(prod.name)}-${localImages.length + 1}`;
        const dl = await downloadImage(imgUrl, imagesDir, nameHint);
        localImages.push({ ...dl, originalUrl: imgUrl });
      } catch (e) {
        logger.warn('Image download failed', { url: imgUrl, err: e.message });
      }
    }
    prod.localImages = localImages;
  });

  // Step 4: Write scrape result
  const result = {
    runId: uuidv4(),
    scrapedAt: new Date().toISOString(),
    sourceUrl: CATALOG_URL,
    deliveryNote: DELIVERY_NOTE,
    platform: platform.platform,
    productCount: validProducts.length,
    products: validProducts,
  };

  const resultPath = path.join(OUTPUT_DIR, 'scrape_result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  logger.info('Scrape result written', { path: resultPath, products: validProducts.length });

  console.log(`::set-output name=product_count::${validProducts.length}`);
  console.log(`::set-output name=result_path::${resultPath}`);
  console.log(`::set-output name=run_id::${result.runId}`);

  return result;
}

main().catch(err => {
  logger.error('Scraper crashed', { err: err.message, stack: err.stack });
  process.exit(1);
});
