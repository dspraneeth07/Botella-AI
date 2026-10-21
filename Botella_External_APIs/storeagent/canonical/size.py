"""Bottle-size & pack parser.

Volume/pack live in a mix of columns and the product name, in liquor-specific
notations:
  uom:        "750ML", "700ML", "375ML"
  pack_size:  "1", "6", "10", "Single", "1.75"
  name:       "Tito's Vodka 1.75", "Fireball .05", "Fireball .100", "Austin East 6pk"
Conventions in this data: a leading-dot decimal means litres (".05" = 50 ml,
".100" = 100 ml, ".375" = 375 ml); bare decimals like "1.75"/"0.75" are litres.
Proof numbers ("Smirnoff 100", "Jack 129.8") must NOT be read as sizes, so bare
decimals are only accepted when they match known bottle sizes.
"""
from __future__ import annotations

import re

# Known bottle sizes in litres (used to disambiguate bare decimals from proof, etc.)
_KNOWN_LITRES = {3.0, 1.75, 1.5, 1.0, 0.75, 0.5, 0.375, 0.355, 0.33, 0.25,
                 0.2, 0.187, 0.1, 0.05}

_ML = re.compile(r"(\d+(?:\.\d+)?)\s*ml\b", re.I)
_L = re.compile(r"(\d+(?:\.\d+)?)\s*(?:l|ltr|liter|litre)\b", re.I)
_LEADING_DOT = re.compile(r"(?<!\d)\.(\d{1,3})\b")        # ".05", ".100", ".375"
_BARE_DEC = re.compile(r"(?<!\d)(\d\.\d{1,3})(?!\d)")      # "1.75", "0.75"
_PACK_IN_NAME = re.compile(r"(\d{1,2})\s*(?:pk|pack)\b", re.I)

# Small-format ("nip") ceiling in millilitres. A product at or under this is
# never recommended and never lands on a buy list: the nip rack sells huge
# unit counts at pocket prices, so unit-ranked slices drown real bottles in
# minis. Set the threshold to 0 to turn the exclusion off entirely.
SMALL_FORMAT_MAX_ML = 50.0

# Only consulted when the volume is unparseable - that unknown-size gap is
# what previously let un-sized nips through as "full size".
_MINI_MARKER = re.compile(r"\b(?:mini|miniature|nip)s?\b", re.I)


def is_small_format(
    product_name: str | None,
    *,
    size_ml: float | None = None,
    category: str | None = None,
    max_ml: float = SMALL_FORMAT_MAX_ML,
) -> bool:
    """True when the product is a mini that must never be recommended.

    A known volume decides on its own: at or under ``max_ml`` is a mini, above
    it is not (so a 100ml stays eligible under the default 50ml ceiling). The
    name/category marker is the fallback for products whose size cannot be
    parsed at all. ``max_ml <= 0`` disables the whole check.
    """
    if max_ml <= 0:
        return False
    ml = size_ml if size_ml is not None else parse_size_ml(product_name, None, None)
    if ml is not None:
        return ml <= max_ml
    return bool(_MINI_MARKER.search(f"{product_name or ''} {category or ''}"))


def _ml_from_text(text: str) -> float | None:
    t = text or ""
    m = _ML.search(t)
    if m:
        return round(float(m.group(1)), 2)
    m = _L.search(t)
    if m:
        return round(float(m.group(1)) * 1000, 2)
    m = _LEADING_DOT.search(t)
    if m:
        litres = float("0." + m.group(1))
        return round(litres * 1000, 2)
    for m in _BARE_DEC.finditer(t):
        litres = float(m.group(1))
        if litres in _KNOWN_LITRES:
            return round(litres * 1000, 2)
    return None


def parse_size_ml(product_name: str | None, pack_size: str | None, uom: str | None) -> float | None:
    """Best-effort bottle/can volume in millilitres, or None if not determinable."""
    for src in (uom, product_name, pack_size):
        ml = _ml_from_text(src or "")
        if ml:
            return ml
    return None


def parse_pack_count(pack_size: str | None, product_name: str | None) -> int:
    """Units per pack (default 1)."""
    ps = (pack_size or "").strip().lower()
    # Integer pack_size like "6", "10", "24" -> a real pack; decimals are sizes, not packs.
    if re.fullmatch(r"\d{1,3}", ps):
        return max(int(ps), 1)
    # Empty / "single" / a decimal size: fall back to a "Npk"/"Npack" hint in the name.
    m = _PACK_IN_NAME.search(product_name or "")
    if m:
        return max(int(m.group(1)), 1)
    return 1
