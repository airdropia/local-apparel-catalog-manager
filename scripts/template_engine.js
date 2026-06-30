/**
 * scripts/template_engine.js — Multi-platform content generation matrix
 *
 * Reads a normalized product list (from scraper.js or manual_processor.js)
 * and generates 4 isolated destination outputs:
 *
 *   1. /output/telegram/      Self-contained HTML w/ inline Base64 images
 *   2. /output/whatsapp/      Short, high-conversion caption w/ *bold*
 *   3. /output/social_media/  Long-form FB/IG caption w/ emojis + hashtags
 *   4. /output/tiktok/        Short hook text + video description
 *
 * Multi-language support:
 *   - English (default)
 *   - Roman Urdu
 *   - Urdu (Arabic script) — saved as .urdu.txt variant
 *
 * Usage:
 *   node scripts/template_engine.js
 *
 * Env:
 *   SCRAPE_RESULT  (optional)  Path to scrape_result.json (link mode)
 *   MANUAL_RESULT  (optional)  Path to manual_result.json (manual mode)
 *   OUTPUT_DIR     (optional)  defaults to ./output
 *   BRAND_NAME     (optional)  defaults to "Local Boutique"
 *   CITY           (optional)  defaults to "Narowal"
 *   LANGUAGES      (optional)  comma-sep, defaults to "en,roman"
 *   IMAGE_MANIFEST (optional)  path to image_manifest.json for Base64 embedding
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const {
  logger,
  atomicWriteJson,
  slugify,
  emojiFor,
  buildHashtags,
} = require('./utils');

// ─── LOAD INPUT ─────────────────────────────────────────────────────────────
function loadInput() {
  const sources = [
    process.env.SCRAPE_RESULT,
    process.env.MANUAL_RESULT,
  ].filter(Boolean);

  if (sources.length === 0) {
    logger.error('Either SCRAPE_RESULT or MANUAL_RESULT env var must be set');
    process.exit(1);
  }

  const sourcePath = sources[0];
  if (!fs.existsSync(sourcePath)) {
    logger.error('Input file not found', { path: sourcePath });
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  return data;
}

// ─── LOAD IMAGE MANIFEST (for Base64 embedding in Telegram) ─────────────────
function loadImageManifest() {
  const manifestPath = process.env.IMAGE_MANIFEST;
  if (!manifestPath || !fs.existsSync(manifestPath)) return { images: [] };
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { images: [] };
  }
}

// ─── MULTI-LANGUAGE CAPTION DICTIONARY ──────────────────────────────────────
const DICT = {
  en: {
    new: 'NEW ARRIVAL',
    price: 'Price',
    fabric: 'Fabric',
    color: 'Color',
    pieces: 'Pieces',
    includes: 'Includes',
    delivery: 'Delivery',
    orderNow: 'Order Now',
    contact: 'Contact to order',
    specs: 'Specs',
    visitLink: 'Visit our shop',
  },
  roman: {
    new: 'NAYA AIJHAZ',
    price: 'Daam',
    fabric: 'Kapra',
    color: 'Rang',
    pieces: 'Tukde',
    includes: 'Shamil',
    delivery: 'Delivery',
    orderNow: 'Order Abhi Karein',
    contact: 'Order ke liye rabta karein',
    specs: 'Tafseelat',
    visitLink: 'Hamara shop dekhein',
  },
  urdu: {
    new: 'نیا آئٹم',
    price: 'قیمت',
    fabric: 'کپڑا',
    color: 'رنگ',
    pieces: 'ٹکڑے',
    includes: 'شامل',
    delivery: 'ڈیلیوری',
    orderNow: 'آرڈر ابھی کریں',
    contact: 'آرڈر کے لیے رابطہ کریں',
    specs: 'تفصیلات',
    visitLink: 'ہمارا شاپ دیکھیں',
  },
};

// ─── BUILD SPEC LINE ────────────────────────────────────────────────────────
function buildSpecLines(specs, lang = 'en') {
  const t = DICT[lang] || DICT.en;
  const lines = [];
  if (specs.fabric)   lines.push(`${t.fabric}: ${specs.fabric}`);
  if (specs.color)    lines.push(`${t.color}: ${specs.color}`);
  if (specs.pieces)   lines.push(`${t.pieces}: ${specs.pieces}`);
  if (specs.components) lines.push(`${t.includes}: ${specs.components}`);
  if (specs.season)   lines.push(`Season: ${specs.season}`);
  return lines;
}

// ─── 1. TELEGRAM EMBEDDED MODULE (HTML + Base64) ────────────────────────────
function buildTelegram(product, brand, imageManifest, lang = 'en') {
  const t = DICT[lang] || DICT.en;
  const emoji = emojiFor(product.specs?.gender || product.name);
  const specs = buildSpecLines(product.specs || {}, lang);

  // Find Base64 for first image if available
  let imgTag = '';
  const manifestEntry = (imageManifest.images || []).find(im =>
    product.localImages?.some(li => im.source === li.path || im.source?.includes(path.basename(li.path || '')))
  );
  if (manifestEntry?.variants?.base64) {
    imgTag = `<img src="${manifestEntry.variants.base64}" alt="${escapeHtml(product.name)}" style="max-width:100%;border-radius:8px;">`;
  }

  const specBlock = specs.length
    ? `<b>${t.specs}</b><br>${specs.map(s => `• ${escapeHtml(s)}`).join('<br>')}`
    : '';

  const deliveryLine = product.deliveryNote
    ? `<br><b>${t.delivery}:</b> ${escapeHtml(product.deliveryNote)}`
    : '';

  return `<!-- Telegram Embed for ${escapeHtml(product.name)} -->
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:12px;border:1px solid #e0e0e0;border-radius:12px;background:#fff;">
  ${imgTag}
  <h2 style="margin:8px 0 4px;font-size:20px;color:#1a1a1a;">${emoji} <b>${escapeHtml(product.name)}</b></h2>
  ${product.sku ? `<code style="font-size:12px;color:#666;">SKU: ${escapeHtml(product.sku)}</code><br>` : ''}
  <p style="font-size:22px;color:#0a7d24;margin:8px 0;"><b>${escapeHtml(product.price?.display || 'N/A')}</b></p>
  ${specBlock ? `<div style="margin:8px 0;font-size:14px;color:#333;">${specBlock}</div>` : ''}
  ${product.description ? `<p style="font-size:13px;color:#555;margin:8px 0;">${escapeHtml(product.description.slice(0, 280))}</p>` : ''}
  <div style="margin-top:12px;padding:8px;background:#f7f7f7;border-radius:6px;font-size:13px;">
    <b>${escapeHtml(brand)}</b>${deliveryLine}
  </div>
</div>`;
}

// ─── 2. WHATSAPP CAPTION ────────────────────────────────────────────────────
function buildWhatsApp(product, brand, lang = 'en') {
  const t = DICT[lang] || DICT.en;
  const emoji = emojiFor(product.specs?.gender || product.name);
  const specs = buildSpecLines(product.specs || {}, lang);

  const lines = [];
  lines.push(`*🔥 ${t.new.toUpperCase()} 🔥*`);
  lines.push('');
  lines.push(`${emoji} *${product.name}*`);
  if (product.sku) lines.push(`_${product.sku}_`);
  lines.push('');
  lines.push(`💰 *${t.price}: ${product.price?.display || 'N/A'}*`);
  if (specs.length) {
    lines.push('');
    lines.push(`*${t.specs}:*`);
    specs.forEach(s => lines.push(`▪️ ${s}`));
  }
  if (product.deliveryNote) {
    lines.push('');
    lines.push(`🚚 ${t.delivery}: ${product.deliveryNote}`);
  }
  lines.push('');
  lines.push(`📞 *${t.contact}:*`);
  lines.push(`_${brand}_`);
  lines.push('');
  lines.push(`_(Attach image manually — WhatsApp Web does not support inline images via text)_`);

  return lines.join('\n');
}

// ─── 3. SOCIAL MEDIA (FB/IG) LONG-FORM ──────────────────────────────────────
function buildSocialMedia(product, brand, city, lang = 'en') {
  const t = DICT[lang] || DICT.en;
  const emoji = emojiFor(product.specs?.gender || product.name);
  const priceEmoji = '💰';
  const locationEmoji = '📍';
  const deliveryEmoji = '🚚';

  const specs = product.specs || {};
  const hashtags = buildHashtags({
    city,
    category: product.name,
    season: specs.season,
  });

  const lines = [];
  lines.push(`${emoji} ${t.new.toUpperCase()} ${emoji}`);
  lines.push('');
  lines.push(`${product.name}`);
  lines.push('');
  lines.push(`${priceEmoji} ${t.price}: ${product.price?.display || 'N/A'}`);
  if (product.sku) lines.push(`🔖 SKU: ${product.sku}`);
  lines.push('');
  lines.push(`━━━━━━━━━━━━━━━`);
  lines.push(`📋 ${t.specs.toUpperCase()}`);
  if (specs.fabric) lines.push(`🧵 ${t.fabric}: ${specs.fabric}`);
  if (specs.color)  lines.push(`🎨 ${t.color}: ${specs.color}`);
  if (specs.pieces) lines.push(`📦 ${t.pieces}: ${specs.pieces}`);
  if (specs.components) lines.push(`🧩 ${t.includes}: ${specs.components}`);
  if (specs.season) lines.push(`🗓️ Collection: ${specs.season}`);
  lines.push(`━━━━━━━━━━━━━━━`);
  lines.push('');
  if (product.description) {
    lines.push(product.description.slice(0, 500));
    lines.push('');
  }
  if (product.deliveryNote) {
    lines.push(`${deliveryEmoji} ${t.delivery}: ${product.deliveryNote}`);
  } else {
    lines.push(`${deliveryEmoji} ${t.delivery}: All over Pakistan`);
  }
  lines.push(`${locationEmoji} ${city}, Pakistan`);
  lines.push('');
  lines.push(`📞 ${t.contact}:`);
  lines.push(`✆ Inbox / WhatsApp us`);
  lines.push(`🏠 ${brand}`);
  lines.push('');
  lines.push(hashtags.join(' '));

  return lines.join('\n');
}

// ─── 4. TIKTOK HOOK + DESCRIPTION ───────────────────────────────────────────
function buildTikTok(product, brand, city, lang = 'en') {
  const t = DICT[lang] || DICT.en;
  const emoji = emojiFor(product.specs?.gender || product.name);

  // Hook: under 7 words, punchy
  const nameWords = product.name.split(/\s+/).slice(0, 4).join(' ');
  const hook = `${emoji} ${nameWords} • ${product.price?.display || ''}`.trim();

  // Description (max ~150 chars for TikTok readability)
  const hashtags = buildHashtags({ city, category: product.name }).slice(0, 6);
  const desc = [
    `${product.name}`,
    `${t.price}: ${product.price?.display || 'N/A'}`,
    product.deliveryNote ? `${deliveryEmoji('🚚')} ${product.deliveryNote}` : '',
    `${brand} • ${city}`,
    hashtags.join(' '),
  ].filter(Boolean).join('\n');

  return {
    hookText: hook.slice(0, 60),
    description: desc,
    fullScript: `${hook}\n\n${desc}`,
  };
}

function deliveryEmoji(e) { return e; } // tiny passthrough for clarity

// ─── HTML ESCAPE ────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── ENSURE DIR ─────────────────────────────────────────────────────────────
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '..', 'output');
  const BRAND_NAME = process.env.BRAND_NAME || 'Local Boutique';
  const CITY = process.env.CITY || 'Narowal';
  const LANGUAGES = (process.env.LANGUAGES || 'en,roman').split(',').map(s => s.trim());

  const data = loadInput();
  const imageManifest = loadImageManifest();

  const products = data.products || [data.product].filter(Boolean);
  if (products.length === 0) {
    logger.error('No products found in input');
    process.exit(1);
  }

  logger.info('Generating templates', {
    productCount: products.length,
    languages: LANGUAGES,
    brand: BRAND_NAME,
    city: CITY,
  });

  const outDirs = {
    telegram: path.join(OUTPUT_DIR, 'telegram'),
    whatsapp: path.join(OUTPUT_DIR, 'whatsapp'),
    social_media: path.join(OUTPUT_DIR, 'social_media'),
    tiktok: path.join(OUTPUT_DIR, 'tiktok'),
  };
  Object.values(outDirs).forEach(ensureDir);

  const manifest = {
    runId: data.runId || uuidv4(),
    generatedAt: new Date().toISOString(),
    brand: BRAND_NAME,
    city: CITY,
    languages: LANGUAGES,
    productCount: products.length,
    outputs: [],
  };

  for (const product of products) {
    const slug = slugify(product.name) || product.id || 'item';
    const deliveryNote = product.deliveryNote || data.deliveryNote || '';

    // Merge delivery note into product for templates
    product.deliveryNote = deliveryNote;

    for (const lang of LANGUAGES) {
      const langSuffix = lang === 'en' ? '' : `.${lang}`;

      // Telegram
      const tg = buildTelegram(product, BRAND_NAME, imageManifest, lang);
      const tgPath = path.join(outDirs.telegram, `${slug}${langSuffix}.html`);
      fs.writeFileSync(tgPath, tg);
      manifest.outputs.push({ platform: 'telegram', lang, product: slug, path: tgPath });

      // WhatsApp
      const wa = buildWhatsApp(product, BRAND_NAME, lang);
      const waPath = path.join(outDirs.whatsapp, `${slug}${langSuffix}.txt`);
      fs.writeFileSync(waPath, wa);
      manifest.outputs.push({ platform: 'whatsapp', lang, product: slug, path: waPath });

      // Social Media
      const sm = buildSocialMedia(product, BRAND_NAME, CITY, lang);
      const smPath = path.join(outDirs.social_media, `${slug}${langSuffix}.txt`);
      fs.writeFileSync(smPath, sm);
      manifest.outputs.push({ platform: 'social_media', lang, product: slug, path: smPath });

      // TikTok
      const tk = buildTikTok(product, BRAND_NAME, CITY, lang);
      const tkPath = path.join(outDirs.tiktok, `${slug}${langSuffix}.txt`);
      fs.writeFileSync(tkPath, tk.fullScript);
      manifest.outputs.push({
        platform: 'tiktok',
        lang,
        product: slug,
        path: tkPath,
        hook: tk.hookText,
      });
    }
  }

  // Write manifest
  const manifestPath = path.join(OUTPUT_DIR, 'template_manifest.json');
  atomicWriteJson(manifestPath, manifest);
  logger.info('Templates generated', {
    total: manifest.outputs.length,
    manifestPath,
  });

  // GitHub Actions output
  console.log(`::set-output name=output_count::${manifest.outputs.length}`);
  console.log(`::set-output name=manifest_path::${manifestPath}`);
}

main().catch(err => {
  logger.error('Template engine crashed', { err: err.message, stack: err.stack });
  process.exit(1);
});
