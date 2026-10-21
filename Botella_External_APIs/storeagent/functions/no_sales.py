"""A store with no sales at all, said the same way everywhere.

WHY THIS IS A MODULE AND NOT FIVE COPIES OF A STRING. 111 of the 212 stores in
the warehouse have no `sales` rows: onboarded, not yet syncing, or syncing
only their product master. That is a legitimate state, not a fault, and every
capability has to answer for it. Five of them already did, by returning
`{"available": False, "reason": "no sales data for this store"}` - basket,
loss, overview, shrinkage and market each with their own copy of that literal.

Three did not, and each failed differently on the same store:

    customers   AttributeError: 'NoneType' object has no attribute 'isoformat'
    overview    AttributeError: 'NoneType' object has no attribute 'get'
    inventory   ValueError: No sales found for client_id=32

An owner at one of those stores saw the raw exception text on the page. The
reading is the thing that was lost: "we have not received any sales for your
store yet" is an answer, and a traceback is not, even though both mean the
same thing to us.

The refusal shape matters as much as the sentence. `available: False` on the
section is what the frontend's availability check treats as decisive, and the
`reason` beside it is what it shows instead of drawing headings over nothing -
so a capability that refuses this way produces a readable page, and one that
raises produces an error box. See frontend/src/storeagent/availability.js.

NOT THE SAME AS A MEASURED ZERO. A store that really sold nothing yesterday,
or really holds no dead stock, has data and must still render its figures.
This module is only for the case where the feed has sent nothing at all, which
is why every caller tests `as_of is None` - the absence of any sale date - and
never a count that happens to be zero.
"""

from __future__ import annotations

from typing import Any

#: The one sentence, matching the five that already existed verbatim so no
#: screen changes its wording depending on which capability refused.
NO_SALES_REASON = "no sales data for this store"


def unavailable(**extra: Any) -> dict:
    """The refusal a capability section returns when the store has no sales.

    `extra` carries whatever that section's consumers still read off it - a
    count they expect to be present, a status slug - so a refusal stays the
    same shape as the section it replaces.
    """
    return {"available": False, "reason": NO_SALES_REASON, **extra}
