"""LLM provider abstraction.

Single-provider in V1: Ollama (user-installed, localhost). Wrapped behind a
ChatProvider Protocol so swapping to Claude/OpenAI/Groq is a one-day change.
"""

from meetwit.llm.client import ChatMessage, ChatProvider, OllamaProvider

__all__ = ["ChatMessage", "ChatProvider", "OllamaProvider"]
