"""Claude narration layer (Phase 1.5).

Turns the deterministic function outputs into natural, owner-friendly prose —
over the SAME numbers the functions computed. The model NEVER invents a figure:
it is handed the exact facts as JSON and instructed to quote only those. If no
API key is configured (or the call fails), narration is simply absent and the
deterministic templated briefing stands on its own.
"""
from .narrate import narrate_capability, narration_available

__all__ = ["narrate_capability", "narration_available"]
