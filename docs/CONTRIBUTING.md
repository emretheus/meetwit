# Contributing to Meetwit

Meetwit is MIT-licensed and accepts contributions. Be kind. Be specific.

## Branch & commit conventions

- Branches: `feat/<short-slug>`, `fix/<short-slug>`, `chore/<short-slug>`, `docs/<short-slug>`
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `perf:`, `test:`, `build:`, `ci:`)
- Each commit should compile and pass tests on its own (no "wip" commits in PRs).

## Setting up the dev loop

See [BUILDING.md](./BUILDING.md). Quick start once installed:

```bash
./scripts/bootstrap.sh
pnpm tauri:dev   # in one terminal
uv --directory backend run python -m meetwit   # in another (until Week 2)
```

## Architectural decisions (ADRs)

Every irreversible technical decision gets a record in [`docs/DECISIONS/`](./DECISIONS/). When opening a PR that locks in a new library, schema, or process, include the ADR in the same PR. Format: ADR-NNNN-kebab-case.md.

## PR checklist

Before opening a PR, verify locally:

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] `cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest`
- [ ] `pnpm -F meetwit-desktop lint && pnpm -F meetwit-desktop typecheck && pnpm -F meetwit-desktop build`
- [ ] If you changed audio, ASR, or RAG paths: ran the relevant smoke test from [`docs/weekly/`](./weekly/) (once published)

## Lefthook (recommended)

```bash
brew install lefthook
lefthook install   # wires the hooks defined in lefthook.yml
```

## Reporting issues

Include: macOS version, Mac model (M1/M2/M3), Meetwit version, the failing command's output, and `~/Library/Application Support/Meetwit/logs/` if relevant. Redact transcripts / doc contents.

## Privacy is a hard line

Any PR that introduces an outbound network request to a destination other than `localhost:11434` (Ollama) or `localhost:5167` (sidecar) **must** include explicit user opt-in and a [PRIVACY.md](./PRIVACY.md) update. No exceptions.
