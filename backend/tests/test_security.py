"""Security-regression tests for the input guards added after the audit.

Covers the two trickiest fixes:
  - the SSRF base_url validator (DNS-resolving + IP-encoding aware)
  - folder-indexing symlink confinement (no escaping the chosen root)
"""

from __future__ import annotations

from pathlib import Path

import pytest

from meetwit.llm.providers import _validate_base_url
from meetwit.services.indexer import discover_files


@pytest.mark.parametrize(
    "bad_url",
    [
        "http://169.254.169.254/latest/meta-data/",  # AWS IMDS by IP
        "http://metadata.google.internal/",  # GCP metadata by name
        "http://metadata/",  # bare metadata alias
        "http://2852039166/",  # decimal encoding of 169.254.169.254
        "http://0xA9FEA9FE/",  # hex encoding of 169.254.169.254
        "ftp://example.com/",  # non-http(s) scheme
        "http:///no-host",  # missing host
    ],
)
def test_validate_base_url_blocks_ssrf(bad_url: str) -> None:
    with pytest.raises(ValueError):
        _validate_base_url(bad_url)


@pytest.mark.parametrize(
    "ok_url",
    [
        "http://127.0.0.1:1234/v1",  # local LM Studio
        "http://localhost:11434",  # local Ollama
        "http://192.168.1.5:11434",  # LAN box
        "https://api.openai.com/v1",  # cloud provider
    ],
)
def test_validate_base_url_allows_legitimate(ok_url: str) -> None:
    # Returns the trimmed url (no trailing slash) and does not raise.
    assert _validate_base_url(ok_url) == ok_url.rstrip("/")


def test_discover_files_skips_symlinked_dir_escape(tmp_path: Path) -> None:
    # A "secrets" dir outside the indexed root containing a supported file.
    secret_dir = tmp_path / "secrets"
    secret_dir.mkdir()
    (secret_dir / "private.md").write_text("TOP SECRET", encoding="utf-8")

    # The folder the user chose to index, with a legit file...
    root = tmp_path / "notes"
    root.mkdir()
    (root / "ok.md").write_text("public note", encoding="utf-8")

    # ...and a symlinked subdirectory pointing at the secrets dir. rglob will
    # recurse into it, but resolve-confinement must keep its files out.
    try:
        (root / "leak").symlink_to(secret_dir, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not supported on this platform")

    found = {p.name for p in discover_files(root)}
    assert "ok.md" in found
    assert "private.md" not in found  # the symlink-escape is blocked


def test_discover_files_rejects_symlinked_root(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    try:
        link.symlink_to(real, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not supported on this platform")
    with pytest.raises(ValueError):
        discover_files(link)
