"""Read API for the StoreAgent dashboard.

A zero-dependency JSON API (stdlib http.server) over the same deterministic
pipeline the CLI uses, plus the optional Claude narration. Serves the React
dashboard build when present. Run: `python -m storeagent.api.server`.
"""
