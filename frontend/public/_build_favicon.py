"""
Generates the PNG favicon set for botella.ai.

The site primarily uses `favicon.svg` (vector, scales perfectly), but every
browser still falls back to PNGs in specific contexts:
  - favicon-32x32.png         → browser tab in older browsers
  - favicon-192x192.png       → Android home-screen shortcut, PWA manifest
  - apple-touch-icon.png      → iOS home-screen icon (180x180, no transparency)

Run when you tweak the design:

    python _build_favicon.py

Outputs land in the same directory (frontend/public/).

The design intentionally mirrors `favicon.svg` exactly: rounded-square
purple-indigo gradient with a bold white "B" centred. Keeping the two
implementations in sync ensures the icon looks the same regardless of which
file the browser ends up using.
"""

from PIL import Image, ImageDraw, ImageFilter
import os

OUT_DIR = os.path.dirname(__file__)

# Brand palette — must match favicon.svg
COLOR_TOP    = (99, 102, 241)   # #6366f1 (indigo)
COLOR_BOTTOM = (168,  85, 247)  # #a855f7 (purple)
COLOR_FG     = (255, 255, 255)  # white "B"


def lerp(a, b, t):
    """Linear interpolate two RGB tuples."""
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render_favicon(size, *, corner_radius_pct=0.22, padding_pct=0.18,
                   flatten_corners=False):
    """
    Render the Botella favicon at the given size.

    corner_radius_pct: rounded-square corner radius as fraction of size.
                      0.22 matches the SVG's 14/64 ratio.
    padding_pct:       inset from edge of the canvas to where the "B" sits.
                      Smaller padding = bigger letter relative to bg.
    flatten_corners:   if True, render solid square corners (no rounding).
                      iOS adds its own rounded mask to apple-touch-icon, so
                      we hand it a flat square + let iOS round it. Otherwise
                      iOS double-rounds and the icon ends up too inset.
    """
    # Supersample 3× for crisp edges, then downsample at the end. This is
    # the standard trick for getting smooth rounded corners + clean letter
    # edges out of PIL without bringing in cairosvg.
    SS = 3
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # ── 1. Diagonal gradient background ────────────────────────────────
    # Pillow doesn't have native gradient support, so we draw it line by
    # line along the anti-diagonal. Each diagonal stripe blends between
    # the top-left and bottom-right colours.
    for y in range(s):
        for x in range(s):
            # Diagonal position: 0 at top-left, 1 at bottom-right
            t = (x + y) / (2 * (s - 1))
            img.putpixel((x, y), (*lerp(COLOR_TOP, COLOR_BOTTOM, t), 255))

    # ── 2. Round the corners (unless we want flat for iOS) ─────────────
    if not flatten_corners:
        radius = int(s * corner_radius_pct)
        mask = Image.new("L", (s, s), 0)
        mdraw = ImageDraw.Draw(mask)
        mdraw.rounded_rectangle((0, 0, s - 1, s - 1), radius=radius, fill=255)
        img.putalpha(mask)

    # ── 3. Draw the "B" letterform centred on the icon ─────────────────
    # Same geometric path as favicon.svg, scaled to fit. The shape: a left
    # vertical stem with two stacked half-circle bumps on the right.
    inset = int(s * padding_pct)
    L = inset                # left edge of B
    R = s - inset            # right edge of B
    T = inset                # top edge
    Bo = s - inset           # bottom edge
    stem_w = int((R - L) * 0.22)    # left-stem width
    mid_y = (T + Bo) // 2
    bump_inset = int((R - L) * 0.08)  # how far the inside of each bump is from the stem

    bdraw = ImageDraw.Draw(img)

    # The B is essentially three rectangles + two pill-shaped lobes.
    # Drawing it with rounded_rectangle calls + a chamfered fill keeps
    # the letterform sharp at every render size.

    # Left stem (full height)
    bdraw.rectangle([L, T, L + stem_w, Bo], fill=COLOR_FG)

    # Upper bump — pill that sticks out from the stem's right edge
    bump_radius_top = (mid_y - T) // 2
    bdraw.rounded_rectangle(
        [L + stem_w - 1, T, R, mid_y + bump_radius_top // 3],
        radius=bump_radius_top,
        fill=COLOR_FG,
    )
    # Cut out the inside of the upper bump so it reads as the B's hole
    inner_top_y0 = T + bump_radius_top // 2
    inner_top_y1 = mid_y - bump_radius_top // 6
    bdraw.rounded_rectangle(
        [L + stem_w + bump_inset, inner_top_y0,
         R - bump_inset, inner_top_y1],
        radius=max(2, bump_radius_top // 3),
        fill=(0, 0, 0, 0),
    )

    # Lower bump — slightly larger than the upper for visual balance
    bump_radius_bot = (Bo - mid_y) // 2 + 2
    bdraw.rounded_rectangle(
        [L + stem_w - 1, mid_y - bump_radius_bot // 4, R, Bo],
        radius=bump_radius_bot,
        fill=COLOR_FG,
    )
    inner_bot_y0 = mid_y + bump_radius_bot // 4
    inner_bot_y1 = Bo - bump_radius_bot // 3
    bdraw.rounded_rectangle(
        [L + stem_w + bump_inset, inner_bot_y0,
         R - bump_inset, inner_bot_y1],
        radius=max(2, bump_radius_bot // 3),
        fill=(0, 0, 0, 0),
    )

    # ── 4. Downsample to target size with high-quality filter ──────────
    final = img.resize((size, size), Image.LANCZOS)
    return final


def write(name, size, **kw):
    img = render_favicon(size, **kw)
    path = os.path.join(OUT_DIR, name)
    img.save(path, "PNG", optimize=True)
    kb = os.path.getsize(path) / 1024
    print(f"  Wrote {name}  ({size}x{size}, {kb:.1f} KB)")


def main():
    print("Building Botella AI favicon set...")
    # Standard browser tab favicon — modern browsers also accept the SVG
    write("favicon-32x32.png", 32)
    # Android / PWA — Chrome uses this for the install prompt + home screen
    write("favicon-192x192.png", 192)
    # iOS adds its own rounded mask; we flatten our corners so iOS doesn't
    # double-round and inset the icon
    write("apple-touch-icon.png", 180, flatten_corners=True)
    print("Done. Reference these from index.html via <link rel> tags.")


if __name__ == "__main__":
    main()
