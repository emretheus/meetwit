"""Summary output-language wiring (#413).

Pure-prompt feature: no LLM required. We assert the language instruction is
built and threaded into the resolved system prompt correctly, and that English
stays a no-op so existing behavior is unchanged.
"""

from __future__ import annotations

import pytest

from meetwit.services.templates import (
    language_instruction,
    language_name,
    resolve_summary_system,
)


def test_language_name_known_and_unknown() -> None:
    assert language_name("de") == "German"
    assert language_name("DE") == "German"
    assert language_name(" fr ") == "French"
    # Unknown code falls through to the raw (stripped) code.
    assert language_name("xx") == "xx"
    # None / empty default to English.
    assert language_name(None) == "English"
    assert language_name("") == "English"


@pytest.mark.parametrize("code", ["en", "EN", " en ", "", None])
def test_english_is_a_noop(code: str | None) -> None:
    """English must add no instruction so V1 behavior is byte-for-byte unchanged."""
    assert language_instruction(code) == ""


def test_non_english_instruction_mentions_language_name() -> None:
    instr = language_instruction("de")
    assert "German" in instr
    # Keys must stay English so the JSON still validates against the schema.
    assert "JSON keys themselves in English" in instr


def test_resolve_summary_system_appends_language() -> None:
    base = resolve_summary_system(template_id="default", custom_prompt=None, language="en")
    localized = resolve_summary_system(template_id="default", custom_prompt=None, language="es")
    # English variant carries no language suffix.
    assert "Spanish" not in base
    # Spanish variant keeps the base prompt AND adds the instruction.
    assert localized.startswith(base.rstrip())
    assert "Spanish" in localized


def test_custom_prompt_still_gets_language() -> None:
    out = resolve_summary_system(
        template_id=None, custom_prompt="Summarize like a pirate.", language="fr"
    )
    assert "pirate" in out
    assert "French" in out


def test_language_defaults_to_english_when_omitted() -> None:
    # The keyword is optional; omitting it must behave like English.
    out = resolve_summary_system(template_id="default", custom_prompt=None)
    assert "German" not in out and "Spanish" not in out
