/**
 * scripts/manual_processor.js — Manual admin mode processor
 *
 * Takes raw text inputs from the workflow_dispatch trigger (item_title,
 * raw_specs, price, image URLs) and produces a normalized product object
 * ready for the template_engine.
 *
 * Pipeline:
 *   1. Parse raw_specs into structured spec fields (fabric, color, etc.)
 *   2. Download images from provided URLs
 *   3. Normalize price
 *   4. Auto-categorize (gents/ladies/kids/accessory)
 *   5. Suggest brand-style title if title is too short
 *
 * Usage:
 *   node scripts/manual_processor.js
 *
 * Env:
 *   ITEM_TITLE      (required)  e.g. "Gents Wash n Wear Premium Suit"
 *   RAW_SPECS       (required)  e.g. "dark blue, 4.5 meters, soft fabric"
 *   PRICE           (required)  e.g. "Rs. 2500"
 *   IMAGE_URL_1     (optional)  Direct image URL
 *   IMAGE_URL_2     (optional)
 *   IMAGE_URL_3     (optional)
 *   DELIVERY_NOTE   (optional)  e.g. "Free delivery in Narowal"
 *   OUTPUT_DIR      (optional)  defaults to ./output
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const { v4: uuidv4 } = require('uuid');

const {
  logger,
  withRetry,
  randomUserAgent,
  safeFilename,
  slugify,
  normalizePrice,
  emojiFor,
} = require('./utils');

const http = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  responseType: 'arraybuffer',
});

// ─── DOWNLOAD IMAGE ─────────────────────────────────────────────────────────
async function downloadImage(url, destDir, idx) {
  return withRetry(
    async () => {
      const buf = await http.get(url, {
        headers: { 'User-Agent': randomUserAgent() },
        maxContentLength: 25 * 1024 * 1024,
      });
      const ext = (url.match(/\.(jpe?g|png|webp|avif|gif)(\?|$)/i) || [, 'jpg'])[1].toLowerCase();
      const safeExt = ext === 'jpeg' ? 'jpg' : ext;
      const fname = `manual-${Date.now()}-${idx}.${safeExt}`;
      const fpath = path.join(destDir, fname);
      fs.writeFileSync(fpath, buf);
      logger.debug('Downloaded manual image', { url, dest: fpath, bytes: buf.length });
      return { url, path: fpath, bytes: buf.length };
    },
    { label: 'downloadManualImage', maxRetries: 3 }
  );
}

// ─── PARSE RAW SPECS ────────────────────────────────────────────────────────
function parseRawSpecs(raw) {
  if (!raw) return {};
  const text = String(raw).toLowerCase();

  // Split on common delimiters: comma, newline, semicolon, pipe
  const tokens = text.split(/[\n,;|]+/).map(t => t.trim()).filter(Boolean);

  const specs = {
    fabric: null,
    color: null,
    pieces: null,
    components: [],
    season: null,
    gender: null,
    length: null,
    raw: raw,
  };

  const fabricKeywords = ['cotton', 'lawn', 'linen', 'silk', 'chiffon', 'wash n wear', 'wash and wear', 'wool', 'khaddar', 'jersey', 'velvet', 'denim', 'organza', 'viscose', 'polyester'];
  const colorKeywords = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'pink', 'purple', 'brown', 'grey', 'gray', 'orange', 'maroon', 'beige', 'navy', 'olive', 'peach', 'mustard', 'sky', 'cream', 'charcoal'];
  const seasonKeywords = ['summer', 'winter', 'spring', 'fall', 'autumn', 'eid', 'casual', 'formal', 'party'];
  const maleKeywords = ['gents', 'men', 'male', 'boy', 'gental', 'gentleman'];
  const femaleKeywords = ['ladies', 'women', 'female', 'girl', 'lady'];
  const kidsKeywords = ['kids', 'kid', 'child', 'baby', 'junior'];
  const componentKeywords = ['shirt', 'kurta', 'dupatta', 'chunni', 'trouser', 'shalwar', 'pant', 'waistcoat', 'coat', 'kurta shalwar'];

  for (const token of tokens) {
    if (!specs.fabric) {
      const found = fabricKeywords.find(k => token.includes(k));
      if (found) specs.fabric = found;
    }
    if (!specs.color) {
      const found = colorKeywords.find(k => token.includes(k));
      if (found) specs.color = found;
    }
    if (!specs.season) {
      const found = seasonKeywords.find(k => token.includes(k));
      if (found) specs.season = found;
    }
    if (!specs.gender) {
      if (maleKeywords.some(k => token.includes(k))) specs.gender = 'male';
      else if (femaleKeywords.some(k => token.includes(k))) specs.gender = 'female';
      else if (kidsKeywords.some(k => token.includes(k))) specs.gender = 'kids';
    }

    // Length / meters
    const lengthMatch = token.match(/(\d+(?:\.\d+)?)\s*(meter|meters|metre|metres|m)\b/);
    if (lengthMatch) specs.length = `${lengthMatch[1]} m`;

    // Pieces
    const pieceMatch = token.match(/(\d+)\s*(piece|pc|pcs|tukde|takhre)/);
    if (pieceMatch) specs.pieces = parseInt(pieceMatch[1], 10);

    // Components
    componentKeywords.forEach(k => {
      if (token.includes(k) && !specs.components.includes(k)) {
        specs.components.push(k);
      }
    });
  }

  // If gender not detected, infer from title env
  if (!specs.gender) {
    const title = (process.env.ITEM_TITLE || '').toLowerCase();
    if (maleKeywords.some(k => title.includes(k))) specs.gender = 'male';
    else if (femaleKeywords.some(k => title.includes(k))) specs.gender = 'female';
    else if (kidsKeywords.some(k => title.includes(k))) specs.gender = 'kids';
  }

  if (specs.components.length === 0) {
    // Default components based on gender
    if (specs.gender === 'male') specs.components = ['shirt', 'trouser'];
    else if (specs.gender === 'female') specs.components = ['shirt', 'dupatta', 'trouser'];
  }
  specs.components = specs.components.join(', ');

  return specs;
}

// ─── AUTO-CATEGORIZE ────────────────────────────────────────────────────────
function autoCategorize(title, specs) {
  const text = `${title} ${specs.gender || ''} ${specs.fabric || ''}`.toLowerCase();
  if (/(suit|kurta|shalwar|kameez|wash\s*n\s*wear)/.test(text)) return 'Suit';
  if (/(saree|kurti|lawn\s*suit)/.test(text)) return 'Lawn Suit';
  if (/(shirt|t-shirt|tee)/.test(text)) return 'Shirt';
  if (/(pant|trouser|jean)/.test(text)) return 'Trouser';
  if (/(jacket|coat|waistcoat)/.test(text)) return 'Outerwear';
  if (/(sandal|shoe|chappal)/.test(text)) return 'Footwear';
  if (/(dupatta|scarf|stole)/.test(text)) return 'Accessory';
  return 'Apparel';
}

// ─── ENHANCE TITLE ──────────────────────────────────────────────────────────
function enhanceTitle(title, specs) {
  if (!title || title.length < 6) {
    const parts = [];
    if (specs.gender === 'male') parts.push('Gents');
    if (specs.gender === 'female') parts.push('Ladies');
    if (specs.fabric) parts.push(specs.fabric.replace(/\b\w/g, c => c.toUpperCase()));
    parts.push('Premium Suit');
    return parts.join(' ');
  }
  // Trim and title-case
  return title.trim().replace(/\s+/g, ' ');
}

// ─── BUILD MARKETING COPY ───────────────────────────────────────────────────
function buildMarketingDescription(title, specs, price) {
  const parts = [];

  const genderLabel = specs.gender === 'male' ? 'Gents' : specs.gender === 'female' ? 'Ladies' : specs.gender === 'kids' ? 'Kids' : '';
  if (genderLabel) parts.push(`Premium quality ${genderLabel.toLowerCase()} ${title.toLowerCase()}.`);

  if (specs.fabric) parts.push(`Made from ${specs.fabric} fabric for ultimate comfort and durability.`);
  if (specs.color)  parts.push(`Available in beautiful ${specs.color} shade.`);
  if (specs.length) parts.push(`Fabric length: ${specs.length}.`);
  if (specs.components) parts.push(`Set includes: ${specs.components}.`);
  if (specs.season) {
    const seasonText = specs.season === 'summer' ? 'perfect for summer wear' :
                       specs.season === 'winter' ? 'ideal for winter warmth' :
                       `great for ${specs.season} occasions`;
    parts.push(`Season: ${seasonText}.`);
  }
  if (price?.display) parts.push(`Best price in town: ${price.display}.`);

  return parts.join(' ');
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  const ITEM_TITLE = process.env.ITEM_TITLE;
  const RAW_SPECS = process.env.RAW_SPECS;
  const PRICE = process.env.PRICE;
  const DELIVERY_NOTE = process.env.DELIVERY_NOTE || '';
  const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '..', 'output');

  if (!ITEM_TITLE || !RAW_SPECS || !PRICE) {
    logger.error('Missing required env: ITEM_TITLE, RAW_SPECS, PRICE');
    process.exit(1);
  }

  const imagesDir = path.join(OUTPUT_DIR, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  // Step 1: Parse raw specs
  logger.info('Parsing raw specs', { raw: RAW_SPECS });
  const specs = parseRawSpecs(RAW_SPECS);

  // Step 2: Normalize price
  const price = normalizePrice(PRICE);

  // Step 3: Enhance title
  const enhancedTitle = enhanceTitle(ITEM_TITLE, specs);
  logger.info('Enhanced title', { original: ITEM_TITLE, enhanced: enhancedTitle });

  // Step 4: Auto-categorize
  const category = autoCategorize(enhancedTitle, specs);
  logger.info('Auto-categorized', { category });

  // Step 5: Download images
  const imageUrls = [
    process.env.IMAGE_URL_1,
    process.env.IMAGE_URL_2,
    process.env.IMAGE_URL_3,
    process.env.IMAGE_URL_4,
    process.env.IMAGE_URL_5,
  ].filter(Boolean);

  const localImages = [];
  for (let i = 0; i < imageUrls.length; i++) {
    try {
      const dl = await downloadImage(imageUrls[i], imagesDir, i + 1);
      localImages.push({ ...dl, originalUrl: imageUrls[i] });
    } catch (e) {
      logger.warn('Failed to download image', { url: imageUrls[i], err: e.message });
    }
  }
  logger.info(`Downloaded ${localImages.length}/${imageUrls.length} images`);

  // Step 6: Build description
  const description = buildMarketingDescription(enhancedTitle, specs, price);

  // Step 7: Assemble final product object
  const product = {
    id: uuidv4(),
    sourceUrl: null,
    name: enhancedTitle,
    sku: `MANUAL-${Date.now().toString(36).toUpperCase()}`,
    price,
    images: imageUrls,
    localImages,
    description,
    specs,
    category,
    emoji: emojiFor(specs.gender || category),
    scrapedAt: new Date().toISOString(),
    mode: 'manual',
  };

  const result = {
    runId: uuidv4(),
    scrapedAt: new Date().toISOString(),
    mode: 'manual',
    sourceUrl: null,
    deliveryNote: DELIVERY_NOTE,
    platform: 'manual',
    productCount: 1,
    products: [product],
  };

  const resultPath = path.join(OUTPUT_DIR, 'manual_result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  logger.info('Manual result written', { path: resultPath });

  console.log(`::set-output name=product_count::1`);
  console.log(`::set-output name=result_path::${resultPath}`);
  console.log(`::set-output name=run_id::${result.runId}`);
  console.log(`::set-output name=category::${category}`);
}

main().catch(err => {
  logger.error('Manual processor crashed', { err: err.message, stack: err.stack });
  process.exit(1);
});
