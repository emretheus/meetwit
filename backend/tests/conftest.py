"""Shared test fixtures.

The retrieval + indexing tests use the *real* BGE-M3 embedder (we want to
exercise actual embeddings, not a mock). Loading that model is by far the
slowest thing in the suite, so we load it ONCE per session and share the
instance — instead of each test constructing its own `Embedder()` and
reloading the ~2.3 GB model.
"""

from __future__ import annotations

import pytest

from meetwit.indexing import Embedder


@pytest.fixture(scope="session")
def shared_embedder() -> Embedder:
    """One real BGE-M3 embedder for the whole test session."""
    emb = Embedder()
    # Warm it once so the model is resident before the timed tests run.
    emb.encode(["warmup"])
    return emb
