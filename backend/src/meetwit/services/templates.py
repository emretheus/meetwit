"""Built-in summary templates.

Each template tweaks the *summary system prompt* to bias what the model
extracts. Decisions + action items extraction stay constant — templates only
shape the prose summary + which highlights matter.

Kept in code (not the DB) for v1: they're stable, version-controlled, and need
no migration. A custom prompt (free text) can override the template entirely.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SummaryTemplate:
    id: str
    name: str
    description: str
    system: str


_BASE_FORMAT = (
    "Output JSON with keys: overview (≤200 words), key_points (list of short "
    "bullets), company_context (single paragraph or null), "
    "recommended_next_steps (list of bullets). No prose outside the JSON."
)

# Common ISO 639-1 codes → English display names. Used to build a clear,
# unambiguous instruction for the LLM ("Write in German." beats "Write in de.").
# Unknown codes fall back to the raw code, which capable models still handle.
_LANGUAGE_NAMES: dict[str, str] = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "pl": "Polish",
    "ru": "Russian",
    "tr": "Turkish",
    "ar": "Arabic",
    "hi": "Hindi",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "sv": "Swedish",
    "da": "Danish",
    "no": "Norwegian",
    "fi": "Finnish",
    "cs": "Czech",
    "el": "Greek",
    "he": "Hebrew",
    "id": "Indonesian",
    "uk": "Ukrainian",
    "ro": "Romanian",
    "hu": "Hungarian",
    "vi": "Vietnamese",
    "th": "Thai",
}


def language_name(code: str | None) -> str:
    """Map an ISO 639-1 code to an English language name for prompting."""
    if not code:
        return "English"
    return _LANGUAGE_NAMES.get(code.strip().lower(), code.strip())


def language_instruction(code: str | None) -> str:
    """A one-line instruction telling the model which language to write in.

    Empty for English (the model's default) so existing behavior is unchanged.
    Applied to every extraction stage so the *whole* summary — overview,
    decisions, action items, title — comes out in the chosen language (#413).
    """
    normalized = (code or "en").strip().lower()
    if normalized in ("", "en"):
        return ""
    name = language_name(normalized)
    return (
        f"\n\nIMPORTANT: Write ALL output (every string value in the JSON) in "
        f"{name}. Keep the JSON keys themselves in English. Translate the "
        f"content faithfully even though the source transcript may be in "
        f"another language."
    )

TEMPLATES: dict[str, SummaryTemplate] = {
    "default": SummaryTemplate(
        id="default",
        name="Default",
        description="Overview + key points + recommended next steps.",
        system=(
            "You are an assistant that writes concise meeting summaries.\n"
            f"{_BASE_FORMAT}"
        ),
    ),
    "standup": SummaryTemplate(
        id="standup",
        name="Standup",
        description="Yesterday / Today / Blockers per person.",
        system=(
            "You summarize a team standup. In `overview`, give a one-paragraph "
            "status. In `key_points`, list per-person items as "
            "'<name>: <yesterday> | <today> | blockers: <blockers or none>'. "
            "Put cross-cutting blockers in `recommended_next_steps`.\n"
            f"{_BASE_FORMAT}"
        ),
    ),
    "sales": SummaryTemplate(
        id="sales",
        name="Sales Call",
        description="BANT, objections, and next steps.",
        system=(
            "You summarize a sales call. In `overview`, capture the prospect, "
            "their need, and overall sentiment. In `key_points`, cover BANT "
            "(Budget, Authority, Need, Timeline) and any objections raised. "
            "In `recommended_next_steps`, list concrete follow-ups with owners.\n"
            f"{_BASE_FORMAT}"
        ),
    ),
    "interview": SummaryTemplate(
        id="interview",
        name="Interview",
        description="Themes, notable quotes, and follow-ups.",
        system=(
            "You summarize an interview. In `overview`, capture who was "
            "interviewed and the headline takeaways. In `key_points`, list the "
            "major themes and any notable verbatim quotes. In "
            "`recommended_next_steps`, list follow-up questions or actions.\n"
            f"{_BASE_FORMAT}"
        ),
    ),
}


def resolve_summary_system(
    *,
    template_id: str | None,
    custom_prompt: str | None,
    language: str | None = None,
) -> str:
    """Pick the system prompt for the summary stage.

    Precedence: custom_prompt (free text) > template > default.
    A custom prompt is appended to the base JSON-format instruction so the
    output still validates against the schema. The optional ``language`` adds
    a trailing instruction so the summary is written in that language (#413).
    """
    if custom_prompt and custom_prompt.strip():
        base = f"{custom_prompt.strip()}\n\n{_BASE_FORMAT}"
    else:
        tmpl = TEMPLATES.get((template_id or "default").lower(), TEMPLATES["default"])
        base = tmpl.system
    return base + language_instruction(language)


def list_templates() -> list[SummaryTemplate]:
    return list(TEMPLATES.values())
