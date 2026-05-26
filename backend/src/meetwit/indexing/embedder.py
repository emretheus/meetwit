"""BGE-M3 multilingual embedder.

Loads the model lazily on first encode — keeps process startup fast.

V2 swapped BGE-small-en (384-dim, English-only) for BGE-M3 (1024-dim,
multilingual) so retrieval, conflict detection, and cross-meeting Ask work
in any language (#233/#427). The dimension change is destructive: the vec0
virtual tables are recreated at 1024-dim and documents are re-indexed (see
migration 0008). BGE-M3 is larger (~2.3 GB) and a bit slower than bge-small,
which is the cost of multilingual support.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Sequence

import numpy as np
from numpy.typing import NDArray

DEFAULT_MODEL = "BAAI/bge-m3"
EMBEDDING_DIM = 1024


class Embedder:
    """Thread-safe wrapper around sentence-transformers.

    Singleton-friendly: instantiate once at app startup, reuse for every
    encode call. Internally caches the underlying model.
    """

    def __init__(self, model_name: str = DEFAULT_MODEL) -> None:
        self.model_name = model_name
        self._lock = threading.Lock()
        self._model: object | None = None
        # Run embeddings on CPU by default. BGE-M3 is ~2.3 GB; on Apple's MPS
        # backend it competes with Whisper for Metal memory and OOMs on smaller
        # GPUs (and on the constrained CI runner). Embedding is a one-shot batch
        # op where CPU is plenty fast. Override with MEETWIT_EMBED_DEVICE (e.g.
        # "mps") if a user has the headroom.
        self.device = os.environ.get("MEETWIT_EMBED_DEVICE", "cpu")

    def _ensure_loaded(self) -> object:
        with self._lock:
            if self._model is None:
                # Imported lazily — torch + transformers init is ~2s.
                from sentence_transformers import SentenceTransformer

                self._model = SentenceTransformer(self.model_name, device=self.device)
            return self._model

    def encode(self, texts: Sequence[str]) -> NDArray[np.float32]:
        if not texts:
            return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
        model = self._ensure_loaded()
        # BGE recommends a query prefix for retrieval; we apply it at search
        # time, not indexing time, so leave inputs unmodified here.
        embeddings = model.encode(  # type: ignore[attr-defined]
            list(texts),
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        return np.asarray(embeddings, dtype=np.float32)

    def encode_one(self, text: str) -> NDArray[np.float32]:
        out = self.encode([text])
        result: NDArray[np.float32] = out[0]
        return result
