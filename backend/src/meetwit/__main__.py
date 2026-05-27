"""CLI entrypoint — ``python -m meetwit`` or ``meetwit-sidecar``."""

from __future__ import annotations

import logging
import sys

import structlog
import uvicorn

from meetwit.config import get_settings


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stderr,
        level=level.upper(),
    )
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=True,
    )


def main() -> None:
    # Subcommand dispatch: `meetwit-sidecar mcp` runs the stdio MCP server
    # (for the user's own Claude Code); no arg runs the HTTP sidecar. Same
    # binary serves both roles, so the PyInstaller bundle is unchanged.
    if len(sys.argv) > 1 and sys.argv[1] == "mcp":
        from meetwit.mcp_server import main as mcp_main

        mcp_main()
        return

    settings = get_settings()
    _configure_logging(settings.log_level)
    uvicorn.run(
        "meetwit.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        access_log=False,
        reload=False,
    )


if __name__ == "__main__":
    main()
