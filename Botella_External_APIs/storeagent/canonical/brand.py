"""Brand extractor.

Pulls a canonical brand out of a product name so insights can roll up by brand
("you have $9k of dead Tito's") rather than only by SKU. Deterministic: a curated
dictionary of common liquor/beverage brands (first match wins, longest aliases
first), with a conservative heuristic fallback (the leading words of the name,
minus size/volume noise). Returns None when nothing confident can be extracted.
"""
from __future__ import annotations

import re

# Curated alias -> canonical brand. Lowercased; matched on word boundaries.
# Not exhaustive — covers high-frequency US liquor-retail brands. Extend freely.
_BRANDS: dict[str, str] = {
    # Vodka
    "tito's": "Tito's", "titos": "Tito's", "smirnoff": "Smirnoff", "absolut": "Absolut",
    "grey goose": "Grey Goose", "ketel one": "Ketel One", "svedka": "Svedka",
    "ciroc": "Ciroc", "stolichnaya": "Stolichnaya", "stoli": "Stolichnaya",
    "new amsterdam": "New Amsterdam", "deep eddy": "Deep Eddy", "pinnacle": "Pinnacle",
    # Product lines / POS-truncated forms that must resolve to the parent brand,
    # or cross-store name dedup (market _dedupe_key) treats them as different
    # brands and recommends stocking products the store already sells.
    "pink whitney": "New Amsterdam", "new am": "New Amsterdam",
    # Whiskey / Bourbon / Scotch
    "jack daniel's": "Jack Daniel's", "jack daniels": "Jack Daniel's", "jim beam": "Jim Beam",
    "maker's mark": "Maker's Mark", "makers mark": "Maker's Mark", "jameson": "Jameson",
    "crown royal": "Crown Royal", "buffalo trace": "Buffalo Trace", "wild turkey": "Wild Turkey",
    "woodford reserve": "Woodford Reserve", "bulleit": "Bulleit", "knob creek": "Knob Creek",
    "evan williams": "Evan Williams", "fireball": "Fireball", "johnnie walker": "Johnnie Walker",
    "macallan": "Macallan", "glenlivet": "Glenlivet", "glenfiddich": "Glenfiddich",
    "george dickel": "George Dickel", "elijah craig": "Elijah Craig", "four roses": "Four Roses",
    "old forester": "Old Forester", "basil hayden": "Basil Hayden", "seagram": "Seagram's",
    # Tequila / Agave
    "patron": "Patrón", "patrón": "Patrón", "jose cuervo": "Jose Cuervo", "don julio": "Don Julio",
    "1800": "1800", "espolon": "Espolòn", "casamigos": "Casamigos", "hornitos": "Hornitos",
    "milagro": "Milagro", "herradura": "Herradura", "el jimador": "El Jimador",
    # Rum
    "bacardi": "Bacardi", "captain morgan": "Captain Morgan", "malibu": "Malibu",
    "kraken": "Kraken", "don q": "Don Q", "mount gay": "Mount Gay", "myers's": "Myers's",
    # Gin / Cognac / Liqueur
    "tanqueray": "Tanqueray", "bombay": "Bombay Sapphire", "hendrick's": "Hendrick's",
    "beefeater": "Beefeater", "hennessy": "Hennessy", "remy martin": "Rémy Martin",
    "courvoisier": "Courvoisier", "baileys": "Baileys", "kahlua": "Kahlúa", "kahlúa": "Kahlúa",
    "grand marnier": "Grand Marnier", "jagermeister": "Jägermeister", "jägermeister": "Jägermeister",
    "cointreau": "Cointreau", "aperol": "Aperol", "campari": "Campari", "rumchata": "RumChata",
    # Beer / Seltzer
    "bud light": "Bud Light", "budweiser": "Budweiser", "michelob": "Michelob", "coors": "Coors",
    "miller": "Miller", "modelo": "Modelo", "corona": "Corona", "heineken": "Heineken",
    "stella artois": "Stella Artois", "guinness": "Guinness", "yuengling": "Yuengling",
    "blue moon": "Blue Moon", "white claw": "White Claw", "truly": "Truly", "high noon": "High Noon",
    "twisted tea": "Twisted Tea", "natural light": "Natural Light", "busch": "Busch",
    "pabst": "Pabst", "dos equis": "Dos Equis", "pacifico": "Pacifico", "sam adams": "Sam Adams",
    # Wine / Bubbles
    "barefoot": "Barefoot", "yellow tail": "Yellow Tail", "josh": "Josh Cellars",
    "kendall-jackson": "Kendall-Jackson", "la marca": "La Marca", "veuve clicquot": "Veuve Clicquot",
    "moet": "Moët & Chandon", "moët": "Moët & Chandon", "andre": "André", "korbel": "Korbel",
    "apothic": "Apothic", "19 crimes": "19 Crimes", "menage a trois": "Ménage à Trois",
    "cupcake": "Cupcake", "stella rosa": "Stella Rosa", "dark horse": "Dark Horse",
    # Mixers / NA
    "red bull": "Red Bull", "coca-cola": "Coca-Cola", "coca cola": "Coca-Cola", "coke": "Coca-Cola",
    "pepsi": "Pepsi", "gatorade": "Gatorade", "monster": "Monster",
}

# Aliases sorted longest-first so "jack daniel's" wins over a bare "jack".
_SORTED_ALIASES = sorted(_BRANDS, key=len, reverse=True)
_ALIAS_RES = [(re.compile(r"\b" + re.escape(a) + r"\b"), _BRANDS[a]) for a in _SORTED_ALIASES]

# Tokens that are size/pack/volume noise, not brand words.
_NOISE = re.compile(
    r"\b(\d+(\.\d+)?\s*(ml|l|liter|litre|oz|ounce|pk|pack|ct|count|can|cans|bottle|btl|"
    r"btls|gal|gallon|case|cs|pet|nr|loose|single|each|ea)|"
    r"\d+\s*x\s*\d+|\d+pk|\d+pack|750|375|1\.75|50ml|\d{2,4})\b",
    re.IGNORECASE)
_PUNCT = re.compile(r"[^a-z0-9'&\s-]")


def extract_brand(product_name: str | None) -> str | None:
    """Best-effort canonical brand for a product name, or None."""
    if not product_name:
        return None
    blob = " " + product_name.strip().lower() + " "
    for rx, canonical in _ALIAS_RES:
        if rx.search(blob):
            return canonical
    return _heuristic_brand(product_name)


def _heuristic_brand(product_name: str) -> str | None:
    """Fallback: the leading 1-2 alpha words of the name, title-cased.

    Conservative — only fires when the lead words look like a name (alphabetic,
    not a size/category token). Better to return None than a wrong brand.
    """
    cleaned = _PUNCT.sub(" ", product_name.lower())
    cleaned = _NOISE.sub(" ", cleaned)
    words = [w for w in cleaned.split() if len(w) >= 2 and not w.isdigit()]
    if not words:
        return None
    lead = words[:2] if len(words) >= 2 and len(words[0]) <= 4 else words[:1]
    brand = " ".join(lead)
    if len(brand) < 3:
        return None
    return brand.title()
