"""Unit tests for the post-meeting output-cleanup helpers.

These guard the defense-in-depth layer that strips the garbage small local
models occasionally emit (placeholder tasks, echoed "Speaker" owners, duplicate
decisions) before it reaches the database / UI.
"""

from __future__ import annotations

from meetwit.services.post_meeting import _clean_owner, _dedup_keep_order, _norm


def test_norm_collapses_case_and_whitespace() -> None:
    assert _norm("  Send   the  Files ") == "send the files"
    assert _norm("Send the files") == _norm("send  THE files")


def test_dedup_keeps_first_occurrence_in_order() -> None:
    got = _dedup_keep_order(
        [
            "Ship the beta on Friday",
            "ship the beta on friday",  # case/space dup
            "Hire a designer",
            "  Ship the beta on Friday  ",  # whitespace dup
        ]
    )
    assert got == ["Ship the beta on Friday", "Hire a designer"]


def test_dedup_drops_blanks() -> None:
    assert _dedup_keep_order(["", "   ", "Real decision"]) == ["Real decision"]


def test_clean_owner_drops_placeholder_and_role_owners() -> None:
    assert _clean_owner(None) is None
    assert _clean_owner("Speaker") is None
    assert _clean_owner("speaker 2") is None
    assert _clean_owner("Unknown") is None
    assert _clean_owner("   ") is None


def test_clean_owner_keeps_real_names() -> None:
    assert _clean_owner("Emre") == "Emre"
    assert _clean_owner("  Dana Lee ") == "Dana Lee"
