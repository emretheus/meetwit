# ADR-0002 — Monorepo layout

- **Status**: Accepted
- **Date**: 2026-05-20
- **Deciders**: @emretheus

## Context

Meetwit V1 has three primary code surfaces: Rust (Tauri shell + audio + ASR), TypeScript (React UI), and Python (FastAPI sidecar + RAG). They share types implicitly via the HTTP API and explicitly via Tauri commands.

Options:
1. Single monorepo (Cargo workspace + pnpm workspace + Python project together)
2. Two repos: `meetwit-desktop` (Tauri) + `meetwit-backend` (Python)
3. Three repos (Rust, frontend, Python)

## Decision

**Single monorepo** at the existing GitHub repo root.

Layout:
```
meetwit/
├── Cargo.toml              # workspace root
├── package.json            # pnpm workspace root
├── pnpm-workspace.yaml
├── desktop/
│   ├── package.json        # frontend (React/Vite/TS)
│   ├── src/                # React source
│   └── src-tauri/          # Rust shell (workspace member)
├── backend/                # Python sidecar (uv project)
│   ├── pyproject.toml
│   └── src/meetwit/
├── docs/
├── scripts/
└── .github/workflows/
```

## Rationale

- **Solo dev:** cross-cutting changes (e.g., bump the IPC contract) are one PR, not three coordinated PRs.
- **Tight coupling:** the sidecar's API and the Rust client of that API need to evolve together. Two repos add merge-order friction.
- **Build pipeline:** the release `.app` bundles the sidecar binary — packaging logic lives next to both.
- **One CI workflow** can lint all three languages in parallel.

## Alternatives

- **Two repos** considered for cleaner independent versioning. Rejected: V1 ships one app; independent versioning is a problem for V2+.
- **Three repos** rejected as pure tax.

## Consequences

- Larger initial repo clone (~mid-size; not huge).
- `git log --oneline` mixes language commits — use scopes in conventional commits (`feat(rust): …`, `feat(backend): …`).
- If post-V1 we ever extract a library (e.g., a standalone Python `meetwit-rag` package), it gets its own repo at that time.
