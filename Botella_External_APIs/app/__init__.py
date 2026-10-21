"""Contextual Intelligence Service.

A stateless FastAPI service that produces 8-10 daily, signal-aware product
recommendations per liquor store. All database-backed data is fetched over HTTP
from the Node backend (see ``app.clients.node_api``); this service persists
nothing and computes every derived metric in-memory.
"""

__version__ = "0.1.0"
