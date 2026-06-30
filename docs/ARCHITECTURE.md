# 📐 Architecture Decision Log

A senior-architect's documentation of the **why** behind each major decision.

---

## ADR-001: GitHub Actions as the only compute platform

**Context**: The user needs an AI digital content manager for a small retail clothing business with zero budget.

**Decision**: Run everything on GitHub Actions free tier (2,000 minutes/month for private repos, unlimited for public).

**Consequences**:
- ✅ Zero cloud cost
- ✅ Built-in secrets management
- ✅ Built-in artifact storage (90-day retention)
- ✅ Built-in git history as audit trail
- ❌ 6-hour job timeout per run
- ❌ No long-running processes (no WebSocket servers)
- ❌ 2,000 min/mo limit on private repos (use public for unlimited)

**Mitigation**: Use concurrency groups to prevent duplicate runs; cache npm/pip installs.

---

## ADR-002: JSON-as-database (no SQLite/Postgres)

**Context**: Need to persist catalog entries across workflow runs.

**Decision**: Use a single `database/catalog.json` file with atomic writes.

**Rationale**:
- File is human-readable (debuggable)
- Diffable in git (version history)
- No DB driver needed in Node.js
- Atomic write (temp + rename) prevents corruption
- Corrupt-file backup (`*.corrupt.{ts}.bak`) preserves data on parse failure

**When to switch**: If `catalog.json` grows past ~50 MB (≈10,000 products), migrate to SQLite via `better-sqlite3`.

---

## ADR-003: Plugin chain for scrapers (Shopify → WooCommerce → Generic)

**Context**: Original plan only supported "Shopify-based" stores, but Pakistani brands use varied stacks.

**Decision**: Implement a plugin chain where each plugin attempts to detect its platform. First match wins.

**Plugins**:
1. **Shopify** — detects `cdn.shopify.com` or `window.Shopify`. Parses `/products/{handle}` links.
2. **WooCommerce** — detects `body.woocommerce` class or `woocommerce` CSS. Parses `/product/{slug}` links.
3. **Generic** — uses OpenGraph tags (`og:title`, `og:image`) + JSON-LD (`@type=Product`) + common CSS selectors (`.price`, `[itemprop="price"]`).

**Fallback behavior**: If no plugin matches, returns `platform: 'unknown'` with empty product list (rather than crashing).

---

## ADR-004: Multi-language output (en + roman + urdu)

**Context**: Target audience is mixed English / Roman Urdu / Urdu readers in Narowal.

**Decision**: Generate parallel outputs per language. The `LANGUAGES` env var controls which languages are produced.

**Implementation**: A `DICT` map in `template_engine.js` provides translations for ~10 key terms (`price`, `fabric`, `delivery`, etc.). Product names, descriptions, and specs are NOT translated (would require an LLM API call) — they pass through as-is.

**Trade-off**: ~3x file count in output, but allows the business owner to pick the right caption per platform (English for IG, Roman Urdu for WhatsApp groups, etc.).

---

## ADR-005: Issue-driven admin UI (zero-cost UX)

**Context**: Non-technical users (shop staff) find the `workflow_dispatch` form intimidating.

**Decision**: Add an **Issue template** that auto-triggers the manual mode workflow when an issue is labeled `manual-item`.

**How it works**:
1. User opens issue with "🤳 Add Manual Catalog Item" template
2. Fills in price, specs, image URLs
3. The `issues: [opened]` trigger fires `run-manual-mode.yml`
4. The `decide` job parses the issue body and only proceeds if the `manual-item` label is present
5. After processing, the workflow **comments back on the issue** with a download link

**Why this is brilliant**: GitHub Issues becomes a free, persistent, threaded admin panel. Anyone with repo access can submit items. Issue history = submission history. Comments = delivery notifications.

---

## ADR-006: Pillow + numpy (not OpenCV) for image processing

**Context**: Need to enhance phone-captured photos (auto white-balance, gamma, contrast, watermark, compress).

**Decision**: Use **Pillow + numpy** instead of OpenCV.

**Rationale**:
- Pillow is pure-Python, smaller install (~5 MB vs ~80 MB for OpenCV)
- numpy gives us vectorized array ops (needed for gray-world WB)
- Pillow's `Image.point()` with a 256-entry LUT is faster than OpenCV's `LUT()` for gamma
- No need for OpenCV's computer-vision features (no face detection, no contours)

**Pillow limitations accepted**:
- No real CLAHE — we use histogram equalization on L channel instead
- No real edge detection — we use simple border-color threshold for auto-crop

---

## ADR-007: Atomic JSON write via temp-file + rename

**Context**: Concurrent workflow runs (or CI tests) could corrupt `catalog.json` if both write at the same time.

**Decision**: Always write to a temp file first (random suffix), then `fs.renameSync()` to the target.

**Why `rename` is atomic on POSIX**: `rename(2)` is guaranteed atomic by POSIX — either the new name appears or it doesn't, never a partial file. On Windows it's atomic only if both files are on the same volume (which they are here).

**Extra safety**: If `safeReadJson` encounters a corrupt JSON, it renames it to `*.corrupt.{ts}.bak` and returns the fallback. This preserves the corrupt file for forensic analysis instead of silently losing data.

---

## ADR-008: Concurrency groups on catalog-write

**Context**: If two workflows run simultaneously and both try to commit `catalog.json` back to main, git will reject the second push.

**Decision**: Use `concurrency: { group: catalog-write, cancel-in-progress: false }` on both link-mode and manual-mode workflows.

**Effect**: The second workflow waits for the first to finish before starting. `cancel-in-progress: false` ensures no work is lost — the second run still executes after the first completes.

---

## ADR-009: GitHub Actions step summaries for visibility

**Context**: Workflow runs produce lots of files; users want a quick visual summary.

**Decision**: Every workflow writes a Markdown table to `$GITHUB_STEP_SUMMARY` showing run stats (product count, image count, template count, output structure).

**Result**: Users see a clean summary on the Actions run page without downloading the artifact.

---

## ADR-010: Base64 inlining for Telegram HTML

**Context**: Telegram's HTML messages don't support external image URLs in custom HTML.

**Decision**: Embed images as `data:image/jpeg;base64,...` URIs directly in the HTML.

**Trade-off**:
- ✅ Fully self-contained — no external calls, no broken links
- ✅ Works in Telegram's HTML rendering
- ❌ File size grows ~33% (Base64 overhead)
- ❌ Some Telegram clients cap message size

**Mitigation**: Image optimizer targets ≤250 KB per catalog image, so Base64 ≈ 333 KB — well within Telegram's 10 MB HTML message cap.

---

## ADR-011: Watermark by default

**Context**: Local boutiques frequently have their product photos stolen by competitors.

**Decision**: All optimized images get a semi-transparent brand-name watermark in the bottom-right corner by default.

**Configuration**: `BRAND_NAME` repo variable controls the text. Set to empty string to disable.

**Implementation**: Pillow's `ImageDraw` with `truetype` font (DejaVu Sans Bold). 110 alpha on background bar, 230 alpha on text — readable but not obtrusive.

---

## ADR-012: Separate utility module (DRY)

**Context**: scraper.js, manual_processor.js, template_engine.js all need retry logic, UA rotation, atomic writes, logging.

**Decision**: Extract all shared code into `scripts/utils.js`. Every other module imports from there.

**Benefit**: Single source of truth for retry policy, logging format, and price parsing. Tests target `utils.js` directly, then integration-test the consumers.
