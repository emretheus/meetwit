"""Conference-URL parsing for calendar events (ADR-0004).

Rust normalizes conference fields when it fetches from Google, but events can
arrive with the fields null (older events, providers that bury the link in the
description). This helper is the sidecar's fallback: the events/sync endpoint
applies it only when the incoming conference_url is missing. Pure + tested.
"""

from __future__ import annotations

import re

ConferenceKind = str  # "zoom" | "meet" | "teams"

# Ordered most-specific-first. Each pattern captures the full join URL.
_PATTERNS: list[tuple[ConferenceKind, re.Pattern[str]]] = [
    ("zoom", re.compile(r"https://[\w.-]*zoom\.us/j/\S+", re.IGNORECASE)),
    ("meet", re.compile(r"https://meet\.google\.com/[\w-]+", re.IGNORECASE)),
    (
        "teams",
        re.compile(r"https://teams\.microsoft\.com/l/meetup-join/\S+", re.IGNORECASE),
    ),
]


def parse_conference_url(*fields: str | None) -> tuple[str | None, ConferenceKind | None]:
    """Scan the given text fields (e.g. location, description) for a known
    conferencing join link. Returns (url, kind) or (None, None).

    The URL is trimmed of trailing punctuation that calendar providers commonly
    append (``>``, ``)``, quotes) so it's directly clickable.
    """
    for text in fields:
        if not text:
            continue
        for kind, pattern in _PATTERNS:
            m = pattern.search(text)
            if m:
                url = m.group(0).rstrip(">).,'\"")
                return url, kind
    return None, None
