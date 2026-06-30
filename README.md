# 🛍️ Local Apparel Catalog Manager

> AI Digital Content Manager for localized retail clothing businesses —
> orchestrated entirely on **GitHub Actions free tier**.
> Generates ready-to-post catalog content for **WhatsApp, Telegram, Facebook/Instagram, and TikTok**
> from either brand-website scraping or manual admin input.

[![CI](https://github.com/airdropia/local-apparel-catalog-manager/actions/workflows/tests.yml/badge.svg)](https://github.com/airdropia/local-apparel-catalog-manager/actions/workflows/tests.yml)
[![Link Mode](https://github.com/airdropia/local-apparel-catalog-manager/actions/workflows/run-link-mode.yml/badge.svg)](https://github.com/airdropia/local-apparel-catalog-manager/actions/workflows/run-link-mode.yml)
[![Manual Mode](https://github.com/airdropia/local-apparel-catalog-manager/actions/workflows/run-manual-mode.yml/badge.svg)](https://github.com/airdropia/local-apparel-catalog-manager/actions/workflows/run-manual-mode.yml)

---

## 📋 Table of Contents
1. [Overview](#-overview)
2. [Architecture (v2)](#-architecture-v2)
3. [Quick Start](#-quick-start)
4. [Workflows](#-workflows)
5. [Engine Components](#-engine-components)
6. [Multi-Language Support](#-multi-language-support)
7. [Issue-as-Admin-UI](#-issue-as-admin-ui)
8. [Configuration](#-configuration)
9. [Catalog JSON Schema](#-catalog-json-schema)
10. [Testing](#-testing)
11. [Security](#-security)
12. [Roadmap](#-roadmap)
13. [License](#-license)

---

## 🎯 Overview

**Local Apparel Catalog Manager** is a content automation system built for a localized retail clothing business (target city: **Narowal, Pakistan**). It runs **100% on GitHub Actions free tier** — no servers, no cloud bills, no DevOps.

### Two Input Modes

| Mode | Trigger | Input | Output |
|------|---------|-------|--------|
| 🔗 **Link Mode** | Manual `workflow_dispatch` | Brand URL (e.g. Nishat Linen) | Full scrape → 4-platform templates |
| 🤳 **Manual Mode** | Manual `workflow_dispatch` **OR** GitHub Issue | Item title + raw specs + price + image URLs | Parsed + enhanced → 4-platform templates |

### Four Output Channels

| Channel | Format | Special |
|---------|--------|---------|
| 💬 **Telegram** | Self-contained HTML | Inline Base64 images (no external calls) |
| 📱 **WhatsApp** | Plain `.txt` | Asterisk `*bold*` notation, short hook |
| 📸 **Facebook / Instagram** | Long-form `.txt` | Emojis + localized hashtags |
| 🎵 **TikTok** | Short hook + description | Hook <7 words for video overlay |

---

## 🏗️ Architecture (v2)

Senior-architect rebuild of the original plan. Key improvements:

```
local-apparel-catalog-manager/
├── .github/
│   ├── workflows/
│   │   ├── run-link-mode.yml         # 🔗 Brand scraper workflow
│   │   ├── run-manual-mode.yml       # 🤳 Manual item workflow (also Issue-triggered)
│   │   ├── scheduled-drop.yml        # ⏰ Daily auto-regeneration of recent entries
│   │   └── tests.yml                 # 🧪 CI: tests + lint + catalog validation
│   └── ISSUE_TEMPLATE/
│       └── manual-item.yml           # 📝 Issue form → auto-triggers Manual Mode
├── scripts/
│   ├── scraper.js                    # Multi-platform scraper (Shopify/Woo/Generic)
│   ├── manual_processor.js           # Raw-text parser + image downloader
│   ├── image_optimizer.py            # Pillow: white-balance + gamma + watermark + compress
│   ├── template_engine.js            # 4-platform × N-language generator
│   ├── db.js                         # Atomic JSON DB layer (append/search/validate/export)
│   └── utils.js                      # Logger, retry, atomic write, UA rotator
├── database/
│   └── catalog.json                  # Append-only product database (auto-committed)
├── templates/
│   ├── telegram_embed.html           # Reference template
│   ├── whatsapp_format.txt           # Reference template
│   └── social_caption.txt            # Reference template
├── tests/
│   ├── utils.test.js                 # Jest unit tests
│   └── db.test.js                    # Jest integration tests
├── docs/
│   └── ARCHITECTURE.md               # Senior-architect decision log
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

### 🆕 Improvements vs Original Plan

| # | Original | v2 Improvement | Why |
|---|----------|----------------|-----|
| 1 | Shopify-only scraper | **3 plugins**: Shopify, WooCommerce, OpenGraph/JSON-LD fallback | Covers ~90% of Pakistani brand sites |
| 2 | No retry logic | **Exponential backoff + jitter** (3 retries, max 8s) | Survives 503/429/Cloudflare hiccups |
| 3 | Static User-Agent | **Rotating UA** via `user-agents` lib | Reduces bot-detection blocks |
| 4 | Direct JSON write (corruption risk) | **Atomic write + corrupt-file backup** | Concurrent writes safe |
| 5 | Single English output | **Multi-language** (English / Roman Urdu / Urdu) | Local audience reach |
| 6 | No image enhancement | **CLAHE contrast + gray-world WB + gamma + auto-crop + watermark** | Phone photos look professional |
| 7 | Only `workflow_dispatch` | **+ Issue trigger + scheduled daily drop** | Non-technical users can post via Issue |
| 8 | No CI | **Jest unit tests + Python smoke test + catalog validation** | Catch regressions before merge |
| 9 | Token in workflow | **GitHub Secrets + repo Variables** (no hardcoded secrets) | Production-safe |
| 10 | No monitoring | **Step summary + optional Discord/Slack webhook** | Know when runs fail |
| 11 | No content versioning | **Run IDs + `database/catalog.json` append-only** | Full audit trail |
| 12 | No DB ops | **CLI: `db.js append/list/search/validate/export`** | Query + export without code |

---

## 🚀 Quick Start

### Option A: Use this repo
1. Clone it
2. Push to your GitHub
3. Go to **Actions** tab → enable workflows
4. Run **"🛍️ Run Link Mode"** with a brand URL

### Option B: Fork-and-customize
1. Fork to your GitHub account
2. Set repo Variables: `BRAND_NAME`, `CITY`
3. (Optional) Set repo Secret: `DISCORD_WEBHOOK` for failure alerts
4. Run workflows

---

## ⚙️ Workflows

### 1. `run-link-mode.yml` — Brand Scraper
**Trigger**: Manual `workflow_dispatch`
**Inputs**:
| Input | Required | Default | Example |
|-------|----------|---------|---------|
| `catalog_url` | ✅ | — | `https://nishatlinen.com/collections/unstitched` |
| `delivery_note` | ❌ | `Free delivery in Narowal` | `Free delivery in Narowal` |
| `max_products` | ❌ | `20` | `50` |
| `languages` | ❌ | `en,roman` | `en,roman,urdu` |

**Outputs**: `Apparel-Brand-Pack` artifact (zip) containing all 4 platform templates + images + manifest.

### 2. `run-manual-mode.yml` — Manual Admin
**Trigger**: Manual `workflow_dispatch` **OR** opening a GitHub Issue with `manual-item` label.
**Inputs** (workflow_dispatch):
| Input | Required | Example |
|-------|----------|---------|
| `item_title` | ✅ | `Gents Wash n Wear Premium Suit` |
| `raw_specs` | ✅ | `dark blue, 4.5 meters, soft fabric, summer collection` |
| `price` | ✅ | `Rs. 2500` |
| `image_url_1` | ❌ | `https://i.imgur.com/abc.jpg` |
| `image_url_2/3` | ❌ | (optional) |
| `delivery_note` | ❌ | `Free delivery in Narowal` |

**Issue-trigger**: Open an issue using the **"🤳 Add Manual Catalog Item"** template → the bot auto-runs the workflow and comments back with the download link.

### 3. `scheduled-drop.yml` — Daily Auto-Regeneration
**Trigger**: `cron: '0 4 * * *'` (9 AM PKT daily) or manual.
Looks back N hours (default 24), picks new catalog entries, regenerates templates with current date/time context. Useful for daily social media posting rhythm.

### 4. `tests.yml` — CI
**Trigger**: Every push/PR to `main`.
Runs: `npm test` (Jest) + ESLint + `db.js validate` + Python image-optimizer smoke test.

---

## 🔧 Engine Components

### `scripts/scraper.js`
- Multi-platform detection (Shopify → WooCommerce → Generic OpenGraph/JSON-LD)
- Per-request rotating User-Agent
- Exponential backoff retries (3 attempts, base 800ms, max 8s, with jitter)
- Concurrency-limited image downloads (max 4 in-flight)
- Spec extraction: fabric, color, pieces, components, season, gender

### `scripts/manual_processor.js`
- Tokenizes raw specs on `,`, `;`, `|`, newlines
- Pattern-matches against fabric/color/season/gender dictionaries
- Auto-detects components (shirt, trouser, dupatta, etc.)
- Enhances short titles with gender + fabric prefixes
- Generates marketing-style description

### `scripts/image_optimizer.py`
- **Auto-orient** based on EXIF (fixes sideways phone photos)
- **Smart auto-crop** (removes white/black borders)
- **Gray-world auto white-balance** (fixes yellow/blue cast from phone sensors)
- **Gamma normalization** (target mean = 128)
- **CLAHE-style local contrast** enhancement (LAB color space)
- **Watermark** with brand name in bottom-right corner
- **Iterative compression** until ≤250 KB per variant
- **3 variants**: catalog (1080px), thumb (400px), Base64 inline
- Outputs `image_manifest.json` linking source → variants

### `scripts/template_engine.js`
- Loads scrape_result or manual_result
- Generates 4 outputs × N languages per product
- Uses simple token-replacement (no template engine dep, fast)
- Emits `template_manifest.json` with all output paths
- Telegram HTML is fully self-contained (Base64 inline)

### `scripts/db.js`
- Atomic JSON writes (temp file + rename)
- Corrupt-file backup (renames to `.corrupt.{ts}.bak` instead of clobbering)
- CLI: `append`, `list`, `search`, `validate`, `export --format csv`
- Search filters: name, category, gender, season, minPrice, maxPrice, mode

### `scripts/utils.js`
- GitHub Actions-aware logger (`::notice::`, `::warning::`, `::error::`, `::debug::`)
- `withRetry(fn, opts)` — exponential backoff with jitter
- `mapWithConcurrency(items, limit, mapper)` — p-limit wrapper
- `randomUserAgent()` — pulls realistic desktop UA strings
- `normalizePrice()` — handles Rs/PKR/INR/USD/₹/₨/$
- `emojiFor()` — category-aware emoji picker

---

## 🌐 Multi-Language Support

| Code | Language | Example |
|------|----------|---------|
| `en` | English | `Price: PKR 2,500` |
| `roman` | Roman Urdu | `Daam: PKR 2,500` |
| `urdu` | Urdu (Arabic script) | `قیمت: PKR 2,500` |

Set via `LANGUAGES` env var (comma-separated). Each language generates a separate file:
```
output/whatsapp/gents-suit.txt              # English (no suffix)
output/whatsapp/gents-suit.roman.txt        # Roman Urdu
output/whatsapp/gents-suit.urdu.txt         # Urdu
```

---

## 📝 Issue-as-Admin-UI

Non-technical team members can submit manual items **without touching the Actions UI**:

1. Go to **Issues** → **New Issue**
2. Pick **"🤳 Add Manual Catalog Item"** template
3. Fill in price, specs, image URLs
4. Submit — the `manual-item` label auto-triggers `run-manual-mode.yml`
5. The bot comments back with the download link

This is a **zero-cost admin UI** powered by GitHub Issues.

---

## 🔧 Configuration

### Repository Variables (Settings → Secrets and variables → Actions → Variables)
| Name | Example | Purpose |
|------|---------|---------|
| `BRAND_NAME` | `Al-Madina Boutique` | Watermark text + caption brand line |
| `CITY` | `Narowal` | Hashtag generation + delivery context |

### Repository Secrets (Settings → Secrets and variables → Actions → Secrets)
| Name | Optional | Purpose |
|------|----------|---------|
| `DISCORD_WEBHOOK` | ✅ | Failure alerts |
| `SLACK_WEBHOOK` | ✅ | Failure alerts |

> **Note**: `GITHUB_TOKEN` is provided automatically by GitHub Actions — no setup needed.

---

## 🗃️ Catalog JSON Schema

```jsonc
{
  "schemaVersion": "2.0.0",
  "updatedAt": "2026-06-30T15:30:00.000Z",
  "totalRuns": 42,
  "entries": [
    {
      "runId": "uuid-v4",
      "timestamp": "2026-06-30T15:30:00.000Z",
      "mode": "link" | "manual" | "scheduled",
      "sourceUrl": "https://...",
      "platform": "shopify" | "woocommerce" | "generic" | "manual",
      "deliveryNote": "Free delivery in Narowal",
      "productCount": 5,
      "products": [
        {
          "id": "uuid-v4",
          "name": "Gents Wash n Wear Premium Suit",
          "sku": "NL-12345",
          "price": {
            "value": 2500,
            "currency": "PKR",
            "display": "PKR 2,500"
          },
          "images": ["https://..."],
          "localImages": [{ "path": "output/images/...", "bytes": 123456 }],
          "description": "...",
          "specs": {
            "fabric": "cotton",
            "color": "blue",
            "pieces": 2,
            "components": "shirt, trouser",
            "season": "summer",
            "gender": "male"
          },
          "scrapedAt": "2026-06-30T15:30:00.000Z"
        }
      ]
    }
  ]
}
```

### Query examples
```bash
# List all runs
node scripts/db.js list

# Search gents summer items under PKR 3000
node scripts/db.js search --gender male --season summer --maxPrice 3000

# Export catalog as CSV
node scripts/db.js export --format csv --output ./catalog.csv

# Validate schema
node scripts/db.js validate
```

---

## 🧪 Testing

```bash
# Install
npm install

# Run all tests
npm test

# Watch mode
npm run test:watch

# Lint
npm run lint

# Validate catalog
npm run validate:catalog
```

Tests cover:
- ✅ `utils.js` — slugify, price parser, emoji picker, atomic writes, corrupt-file recovery
- ✅ `db.js` — append, list, search (by gender/price/season), validate, CSV export
- ✅ `image_optimizer.py` — Python smoke test (Pillow import + process pipeline)

---

## 🔒 Security

### ⚠️ Critical: Token Hygiene
- **Never commit** tokens, passwords, or API keys to the repo
- Use **GitHub Secrets** for sensitive values
- Use **GitHub Variables** for non-sensitive config (brand name, city)
- The included `.gitignore` blocks `.env` files

### Bot-detection avoidance (ethical scraping)
- Rotating User-Agents — but **always respect `robots.txt`**
- 3-retry max with backoff — **don't hammer sites**
- Concurrency limited to 4 parallel image downloads
- Only scrape **publicly accessible product pages**
- For aggressive targets, **get permission first**

### Watermark = Brand Protection
All optimized images carry a semi-transparent brand badge in the bottom-right corner. This discourages copy-paste theft by competing sellers.

---

## 🗺️ Roadmap

- [ ] **Direct social API posting** (FB Graph API, Instagram Graph API) — opt-in
- [ ] **WhatsApp Business API** integration for catalog broadcast
- [ ] **TikTok video template** (FFmpeg overlay generation)
- [ ] **Analytics dashboard** as GitHub Pages site (clicks per catalog entry)
- [ ] **A/B test captions** (generate 2 variants, track conversion)
- [ ] **Multi-tenant** support (multiple boutiques per repo)
- [ ] **Webhook receiver** (POST → trigger scrape)
- [ ] **AI caption rewrite** via LLM API (optional, opt-in)

---

## 📄 License

MIT © airdropia

---

## 🙏 Acknowledgments

Built as a senior-architect rebuild of an initial idea plan, with production hardening:
atomic DB ops, retry/backoff, multi-platform scraping, multi-language captions, image enhancement, CI tests, and an Issue-driven admin UI — all running free on GitHub Actions.
