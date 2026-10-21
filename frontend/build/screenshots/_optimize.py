"""
Resize + recompress every PNG in this folder for web delivery (PNG only).
Raw screenshots can be 1-2 MB each. After this:
- max 800px on the longer side
- PNG re-saved with optimize=True

The site serves these PNGs directly (plain <img>, no WebP), so this step is
OPTIONAL — only run it to shrink an oversized capture:
    python _optimize.py
"""

from PIL import Image
import os
import glob

MAX = 800
HERE = os.path.dirname(__file__)

for path in glob.glob(os.path.join(HERE, "*.png")):
    name = os.path.basename(path)
    if name.startswith("_"):
        continue

    img = Image.open(path).convert("RGBA")
    w, h = img.size
    scale = MAX / max(w, h)
    if scale < 1:
        new_size = (int(w * scale), int(h * scale))
        img = img.resize(new_size, Image.LANCZOS)
        print(f"  resized {name}: {w}x{h} -> {new_size[0]}x{new_size[1]}")

    # Overwrite the PNG (optimised)
    img.save(path, "PNG", optimize=True)

    png_kb = os.path.getsize(path) / 1024
    print(f"  {name}: PNG {png_kb:.0f} KB")

print("\nDone.")
