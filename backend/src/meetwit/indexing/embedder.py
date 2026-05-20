"""BGE-small-en-v1.5 embedder.

Loads the model lazily on first encode — keeps process startup fast.
"""

from __future__ import annotations

import threading
from collections.abc import Sequence

import numpy as np
from numpy.typing import NDArray

DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384


class Embedder:
    """Thread-safe wrapper around sentence-transformers.

    Singleton-friendly: instantiate once at app startup, reuse for every
    encode call. Internally caches the underlying model.
    """

    def __init__(self, model_name: str = DEFAULT_MODEL) -> None:
        self.model_name = model_name
        self._lock = threading.Lock()
        self._model: object | None = None

    def _ensure_loaded(self) -> object:
        with self._lock:
            if self._model is None:
                # Imported lazily — torch + transformers init is ~2s.
                from sentence_transformers import SentenceTransformer

                self._model = SentenceTransformer(self.model_name)
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
