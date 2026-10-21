"""
Generates the Open Graph image for botella.ai at 1200x630 — the standard
size Facebook / LinkedIn / Twitter / Slack expect for link previews.

Run once when you want to refresh the image:

    python _build_og_image.py

Output: og-image.png in the same directory (frontend/public/).

The image renders entirely with PIL no external fonts required. We
fall back to Pillow's default font if Inter / Arial Black aren't
available, so this script works on any machine.
"""

from PIL import Image, ImageDraw, ImageFont
import os
import sys

WIDTH = 1200
HEIGHT = 630
OUT_PATH = os.path.join(os.path.dirname(__file__), "og-image.png")

# Brand palette
BG = (20, 22, 30)               # dark navy
INDIGO = (129, 140, 248)        # var(--lp-accent-light)
PURPLE = (192, 132, 252)        # purple accent
TEXT = (248, 249, 251)          # near-white
MUTED = (142, 148, 173)         # gray

def find_font(size, bold=True):
    """Try a handful of common fonts; fall back to PIL default."""
    candidates = []
    if bold:
        candidates = [
            r"C:\Windows\Fonts\arialbd.ttf",       # Arial Bold (Windows)
            r"C:\Windows\Fonts\segoeuib.ttf",      # Segoe UI Bold
            r"C:\Windows\Fonts\seguisb.ttf",       # Segoe UI Semibold
            "/Library/Fonts/Arial Bold.ttf",       # macOS
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",  # Linux
        ]
    else:
        candidates = [
            r"C:\Windows\Fonts\arial.ttf",
            r"C:\Windows\Fonts\segoeui.ttf",
            "/Library/Fonts/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    # Fallback — Pillow's default. Won't look as nice but won't crash.
    return ImageFont.load_default()


def lerp(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def draw_radial_glow(img, center_x, center_y, radius, color, max_alpha=80):
    """
    Soft radial glow centred at (cx, cy). Approximated with concentric
    semi-transparent circles since PIL doesn't have native gradients.
    """
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    steps = 40
    for i in range(steps, 0, -1):
        t = i / steps
        r = int(radius * t)
        alpha = int(max_alpha * (1 - t) ** 1.8)
        odraw.ellipse(
            [center_x - r, center_y - r, center_x + r, center_y + r],
            fill=(*color, alpha),
        )
    img.alpha_composite(overlay)


def draw_gradient_text(draw, text, position, font, c1, c2):
    """
    Cheap gradient text — render the text once in a temporary image and
    overlay a gradient mask. Pure PIL, no shaping needed.
    """
    # Measure
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    if tw <= 0 or th <= 0:
        return

    # Layer 1: solid text in colour 1
    text_layer = Image.new("RGBA", (tw + 4, th + 4), (0, 0, 0, 0))
    tdraw = ImageDraw.Draw(text_layer)
    tdraw.text((-bbox[0], -bbox[1]), text, font=font, fill=c1)

    # Layer 2: gradient mask (top-left c1, bottom-right c2)
    gradient = Image.new("RGB", (tw + 4, th + 4), c1)
    gd = ImageDraw.Draw(gradient)
    for x in range(tw + 4):
        t = x / max(tw + 3, 1)
        col = lerp(c1, c2, t)
        gd.line([(x, 0), (x, th + 3)], fill=col)

    # Combine: keep alpha from text_layer, use colours from gradient
    text_alpha = text_layer.split()[-1]
    coloured = Image.new("RGBA", (tw + 4, th + 4), (0, 0, 0, 0))
    coloured.paste(gradient, (0, 0))
    coloured.putalpha(text_alpha)

    # Paste into target image
    draw._image.alpha_composite(coloured, dest=position)


def main():
    img = Image.new("RGBA", (WIDTH, HEIGHT), (*BG, 255))

    # Decorative gradient glows
    draw_radial_glow(img, 200, 100, 600, INDIGO, max_alpha=42)
    draw_radial_glow(img, 1050, 530, 600, PURPLE, max_alpha=36)

    draw = ImageDraw.Draw(img)

    # ── Top-left brand bar + eyebrow ──────────────────────────────
    draw.rectangle([60, 80, 90, 86], fill=INDIGO)
    eyebrow_font = find_font(20, bold=True)
    draw.text((100, 70), "BOTELLA AI", font=eyebrow_font, fill=INDIGO)

    # ── Big "Botella" wordmark ────────────────────────────────────
    wordmark_font = find_font(150, bold=True)
    draw_gradient_text(draw, "Botella", (60, 160), wordmark_font, INDIGO, PURPLE)

    # ── Tagline ───────────────────────────────────────────────────
    tag_font = find_font(50, bold=True)
    draw.text((60, 330), "AI Agent for Liquor Stores", font=tag_font, fill=TEXT)

    # ── Sub-tagline ───────────────────────────────────────────────
    sub_font = find_font(28, bold=False)
    draw.text(
        (60, 400),
        "Predict demand. Automate reordering.",
        font=sub_font,
        fill=(196, 201, 217),
    )
    draw.text(
        (60, 440),
        "Grow margins — without the guesswork.",
        font=sub_font,
        fill=(196, 201, 217),
    )

    # ── Bottom URL + accent ───────────────────────────────────────
    draw.rectangle([60, HEIGHT - 90, HEIGHT - 558, HEIGHT - 89], fill=(58, 63, 79))
    # Actually a simple thin line is cleaner
    draw.rectangle([60, HEIGHT - 90, 1140, HEIGHT - 89], fill=(58, 63, 79))

    url_font = find_font(24, bold=True)
    draw.text((60, HEIGHT - 70), "botella.ai", font=url_font, fill=INDIGO)

    pill_font = find_font(20, bold=True)
    draw.text(
        (820, HEIGHT - 68),
        "·  AI · Inventory · Sales · Margins",
        font=pill_font,
        fill=MUTED,
    )

    # ── Subtle dotted grid in the background (decorative) ─────────
    grid_overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid_overlay)
    for x in range(0, WIDTH, 30):
        for y in range(0, HEIGHT, 30):
            gd.point((x, y), fill=(255, 255, 255, 8))
    img.alpha_composite(grid_overlay)

    # Flatten alpha → RGB so the PNG is small + universally supported
    final = Image.new("RGB", img.size, BG)
    final.paste(img, mask=img.split()[-1])
    final.save(OUT_PATH, "PNG", optimize=True)

    size_kb = os.path.getsize(OUT_PATH) / 1024
    print(f"✓ Wrote {OUT_PATH}")
    print(f"  Size: {WIDTH}x{HEIGHT}px, {size_kb:.1f} KB")


if __name__ == "__main__":
    sys.exit(main() or 0)
