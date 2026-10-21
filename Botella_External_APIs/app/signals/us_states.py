"""US state code <-> name lookups shared by the signal clients.

Upstream feeds disagree on how they name states: store profiles carry the
two-letter code ("GA"), NewsData needs the full name as a search phrase
("Georgia"), and ESPN venue addresses return the full name ("Georgia"). One
table keeps those translations consistent.
"""

from __future__ import annotations

STATE_NAMES: dict[str, str] = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "DC": "Washington DC", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii",
    "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine",
    "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska",
    "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
    "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
    "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}

_BY_NAME: dict[str, str] = {name.upper(): code for code, name in STATE_NAMES.items()}


def to_code(value: str | None) -> str:
    """Normalize a state name or code to its uppercase two-letter code.

    Accepts either form ("Georgia", "GEORGIA", "ga") and returns "" for
    anything unrecognized, so callers can compare two normalized values
    without worrying which shape the upstream feed used.
    """
    raw = (value or "").strip().upper()
    if not raw:
        return ""
    if raw in STATE_NAMES:
        return raw
    return _BY_NAME.get(raw, "")
