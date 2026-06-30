#!/usr/bin/env python3
"""
scripts/image_optimizer.py — Visual Processing Pipeline

Features:
  - Auto white-balance correction (gray-world assumption)
  - Gamma normalization for under/over-exposed phone photos
  - Contrast stretch (CLAHE on L channel of LAB)
  - Smart auto-crop (removes white/black borders)
  - Watermark with brand corner badge
  - Multi-size output (catalog 1080x1080, thumb 400x400, original)
  - Compression to <250 KB per variant
  - Batch processing with progress logging

Usage:
  python3 scripts/image_optimizer.py --input <dir> --output <dir> --brand "Your Brand"

Inputs:
  --input   : Directory containing raw images (default: ./output/images)
  --output  : Directory for optimized images (default: ./output/optimized)
  --brand   : Brand text for watermark (default: "Local Boutique")
  --quality : JPEG quality 1-100 (default: 85)
  --max-size: Max dimension in pixels (default: 1080)
"""

import argparse
import io
import os
import sys
import glob
import json
import struct
from datetime import datetime
from pathlib import Path

try:
    from PIL import Image, ImageEnhance, ImageOps, ImageDraw, ImageFont, ImageFilter
    from PIL.ExifTags import Orientation as ExifOrientation
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    NUMPY_AVAILABLE = False


# ─── LOGGING ─────────────────────────────────────────────────────────────────
def log(level: str, msg: str, obj: dict = None):
    """GitHub Actions-friendly logger."""
    ts = datetime.utcnow().isoformat()
    payload = f" {json.dumps(obj)}" if obj else ""
    if os.environ.get("GITHUB_ACTIONS") == "true":
        cmd = {
            "INFO": "notice",
            "WARN": "warning",
            "ERROR": "error",
            "DEBUG": "debug",
        }.get(level, "notice")
        print(f"::{cmd}::{msg}{payload}")
    else:
        print(f"{ts} [{level}] {msg}{payload}")


# ─── AUTO-ORIENT BASED ON EXIF ───────────────────────────────────────────────
def auto_orient(img: Image.Image) -> Image.Image:
    """Rotate image based on EXIF orientation tag."""
    try:
        exif = img._getexif()
        if not exif:
            return img
        orientation = exif.get(0x0112, 1)
        return ImageOps.exif_transpose(img) if orientation > 1 else img
    except Exception:
        return img


# ─── AUTO WHITE BALANCE (Gray-World) ─────────────────────────────────────────
def auto_white_balance(img: Image.Image) -> Image.Image:
    """Apply gray-world assumption to balance color temperature."""
    if not NUMPY_AVAILABLE or img.mode != "RGB":
        return img
    arr = np.asarray(img).astype(np.float32)
    r_mean, g_mean, b_mean = arr[..., 0].mean(), arr[..., 1].mean(), arr[..., 2].mean()
    avg = (r_mean + g_mean + b_mean) / 3.0
    if avg == 0:
        return img
    # Scale each channel so its mean matches the gray-world average.
    scale_r = avg / r_mean if r_mean > 0 else 1.0
    scale_g = avg / g_mean if g_mean > 0 else 1.0
    scale_b = avg / b_mean if b_mean > 0 else 1.0
    arr[..., 0] = np.clip(arr[..., 0] * scale_r, 0, 255)
    arr[..., 1] = np.clip(arr[..., 1] * scale_g, 0, 255)
    arr[..., 2] = np.clip(arr[..., 2] * scale_b, 0, 255)
    return Image.fromarray(arr.astype(np.uint8), "RGB")


# ─── GAMMA NORMALIZATION ─────────────────────────────────────────────────────
def normalize_gamma(img: Image.Image, target_mean: float = 128.0) -> Image.Image:
    """Adjust gamma to bring overall brightness close to target."""
    if not NUMPY_AVAILABLE:
        return img
    arr = np.asarray(img.convert("RGB")).astype(np.float32)
    cur_mean = arr.mean()
    if cur_mean < 1:
        return img
    # gamma < 1 brightens, gamma > 1 darkens
    ratio = target_mean / cur_mean
    gamma = max(0.4, min(2.5, 1.0 / max(ratio, 0.1))) if ratio < 1 else max(0.4, min(2.5, ratio))
    # Apply gamma: out = 255 * (in/255)^(1/gamma)
    table = np.array([((i / 255.0) ** (1.0 / gamma)) * 255 for i in range(256)]).astype(np.uint8)
    return img.convert("RGB").point(table)


# ─── CLAHE-STYLE CONTRAST STRETCH ────────────────────────────────────────────
def enhance_contrast(img: Image.Image) -> Image.Image:
    """CLAHE-inspired local contrast enhancement on L channel of LAB."""
    if not NUMPY_AVAILABLE:
        enhancer = ImageEnhance.Contrast(img)
        return enhancer.enhance(1.15)
    lab = img.convert("RGB").convert("LAB")
    l, a, b = lab.split()
    # Apply histogram equalization on L channel
    l_eq = ImageOps.equalize(l)
    lab_eq = Image.merge("LAB", (l_eq, a, b))
    return lab_eq.convert("RGB")


# ─── SMART AUTO-CROP ─────────────────────────────────────────────────────────
def smart_autocrop(img: Image.Image, border_threshold: int = 10) -> Image.Image:
    """Trim away white/near-white or black/near-black borders."""
    if not NUMPY_AVAILABLE:
        return img
    gray = np.asarray(img.convert("L"))
    h, w = gray.shape
    # Detect white border
    top, bottom, left, right = 0, h - 1, 0, w - 1
    # Top
    while top < h - 1 and np.mean(gray[top, :]) > 255 - border_threshold:
        top += 1
    # Bottom
    while bottom > 0 and np.mean(gray[bottom, :]) > 255 - border_threshold:
        bottom -= 1
    # Left
    while left < w - 1 and np.mean(gray[:, left]) > 255 - border_threshold:
        left += 1
    # Right
    while right > 0 and np.mean(gray[:, right]) > 255 - border_threshold:
        right -= 1
    if top >= bottom or left >= right:
        return img
    margin = 4
    crop_box = (
        max(0, left - margin),
        max(0, top - margin),
        min(w, right + margin + 1),
        min(h, bottom + margin + 1),
    )
    if (crop_box[2] - crop_box[0]) < 32 or (crop_box[3] - crop_box[1]) < 32:
        return img
    return img.crop(crop_box)


# ─── WATERMARK ───────────────────────────────────────────────────────────────
def apply_watermark(img: Image.Image, brand: str) -> Image.Image:
    """Add a subtle semi-transparent brand badge in the bottom-right corner."""
    if not brand:
        return img
    img = img.convert("RGBA")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    # Try to load a font; fall back to default
    font_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    font = None
    for fp in font_paths:
        if os.path.exists(fp):
            try:
                font = ImageFont.truetype(fp, max(14, img.size[0] // 30))
                break
            except Exception:
                continue
    if font is None:
        font = ImageFont.load_default()
    # Background bar
    text_w = draw.textlength(brand, font=font)
    text_h = font.size if hasattr(font, "size") else 16
    pad = 8
    box_w = int(text_w + 2 * pad)
    box_h = int(text_h + 2 * pad)
    margin = 12
    x = img.size[0] - box_w - margin
    y = img.size[1] - box_h - margin
    draw.rectangle([x, y, x + box_w, y + box_h], fill=(0, 0, 0, 110))
    draw.text((x + pad, y + pad), brand, fill=(255, 255, 255, 230), font=font)
    return Image.alpha_composite(img, overlay).convert("RGB")


# ─── COMPRESS UNTIL UNDER TARGET ─────────────────────────────────────────────
def compress_to_target(img: Image.Image, target_kb: int = 250, initial_quality: int = 85) -> bytes:
    """Iteratively lower JPEG quality until under target file size."""
    img = img.convert("RGB")
    quality = initial_quality
    while quality >= 30:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
        size_kb = buf.tell() / 1024
        if size_kb <= target_kb:
            return buf.getvalue()
        quality -= 5
    # Last resort: resize down 10% and retry once
    w, h = img.size
    img2 = img.resize((int(w * 0.9), int(h * 0.9)), Image.LANCZOS)
    buf = io.BytesIO()
    img2.save(buf, format="JPEG", quality=40, optimize=True)
    return buf.getvalue()


# ─── PROCESS SINGLE IMAGE ────────────────────────────────────────────────────
def process_image(src_path: str, out_dir: str, brand: str, quality: int, max_size: int) -> dict:
    """Process a single image and return metadata dict."""
    try:
        img = Image.open(src_path)
    except Exception as e:
        log("ERROR", f"Cannot open {src_path}: {e}")
        return None

    log("INFO", f"Processing {os.path.basename(src_path)}", {
        "size": os.path.getsize(src_path),
        "mode": img.mode,
        "dimensions": img.size,
    })

    # 1. Auto-orient based on EXIF
    img = auto_orient(img)

    # 2. Smart auto-crop
    img = smart_autocrop(img)

    # 3. Auto white balance
    img = auto_white_balance(img)

    # 4. Gamma normalize
    img = normalize_gamma(img)

    # 5. Contrast enhancement
    img = enhance_contrast(img)

    # 6. Resize so longest side = max_size
    w, h = img.size
    if max(w, h) > max_size:
        ratio = max_size / max(w, h)
        img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

    # 7. Watermark
    img = apply_watermark(img, brand)

    # 8. Save variants
    base = Path(src_path).stem
    variants = {}

    # Catalog variant (square-ish, 1080)
    catalog_img = img.copy()
    catalog_img.thumbnail((max_size, max_size), Image.LANCZOS)
    catalog_bytes = compress_to_target(catalog_img, target_kb=250, initial_quality=quality)
    catalog_path = os.path.join(out_dir, f"{base}_catalog.jpg")
    with open(catalog_path, "wb") as f:
        f.write(catalog_bytes)
    variants["catalog"] = {
        "path": catalog_path,
        "bytes": len(catalog_bytes),
        "dimensions": catalog_img.size,
    }

    # Thumbnail (400x400)
    thumb = img.copy()
    thumb.thumbnail((400, 400), Image.LANCZOS)
    thumb_bytes = compress_to_target(thumb, target_kb=60, initial_quality=80)
    thumb_path = os.path.join(out_dir, f"{base}_thumb.jpg")
    with open(thumb_path, "wb") as f:
        f.write(thumb_bytes)
    variants["thumb"] = {
        "path": thumb_path,
        "bytes": len(thumb_bytes),
        "dimensions": thumb.size,
    }

    # Base64 for inline Telegram embedding
    import base64
    b64 = base64.b64encode(catalog_bytes).decode("ascii")
    variants["base64"] = f"data:image/jpeg;base64,{b64}"

    return {
        "source": src_path,
        "variants": variants,
        "processedAt": datetime.utcnow().isoformat() + "Z",
    }


# ─── MAIN ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Image optimizer for apparel catalog")
    parser.add_argument("--input", default="./output/images", help="Input dir with raw images")
    parser.add_argument("--output", default="./output/optimized", help="Output dir for optimized images")
    parser.add_argument("--brand", default=os.environ.get("BRAND_NAME", "Local Boutique"), help="Brand text for watermark")
    parser.add_argument("--quality", type=int, default=85, help="Initial JPEG quality (1-100)")
    parser.add_argument("--max-size", type=int, default=1080, help="Max dimension in pixels")
    parser.add_argument("--manifest", default="./output/image_manifest.json", help="Output manifest JSON path")
    args = parser.parse_args()

    if not PIL_AVAILABLE:
        log("ERROR", "Pillow is not installed. Run: pip install Pillow numpy")
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)
    os.makedirs(os.path.dirname(args.manifest) or ".", exist_ok=True)

    # Find all images
    extensions = ("*.jpg", "*.jpeg", "*.png", "*.webp", "*.avif", "*.gif")
    input_files = []
    for ext in extensions:
        input_files.extend(glob.glob(os.path.join(args.input, ext)))
        input_files.extend(glob.glob(os.path.join(args.input, ext.upper())))

    if not input_files:
        log("WARN", "No input images found", {"input": args.input})
        # Write empty manifest so downstream steps don't fail
        with open(args.manifest, "w") as f:
            json.dump({"images": [], "processedAt": datetime.utcnow().isoformat() + "Z"}, f, indent=2)
        return

    log("INFO", f"Found {len(input_files)} images to process", {"input": args.input})

    results = []
    for f in input_files:
        result = process_image(f, args.output, args.brand, args.quality, args.max_size)
        if result:
            results.append(result)

    manifest = {
        "processedAt": datetime.utcnow().isoformat() + "Z",
        "brand": args.brand,
        "inputDir": args.input,
        "outputDir": args.output,
        "totalProcessed": len(results),
        "images": results,
    }

    with open(args.manifest, "w") as f:
        json.dump(manifest, f, indent=2)

    log("INFO", f"Optimization complete", {
        "total": len(results),
        "manifest": args.manifest,
    })

    # GitHub Actions output
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::set-output name=processed_count::{len(results)}")
        print(f"::set-output name=manifest_path::{args.manifest}")


if __name__ == "__main__":
    main()
