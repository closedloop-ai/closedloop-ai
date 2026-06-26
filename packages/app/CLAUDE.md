# @repo/app — Shared App-Core Layer

> **Agents:** also read `AGENTS.md` in this directory for coding patterns, security rules, and domain conventions.

This package contains surface-agnostic application code shared by the Next.js web
shell (`apps/app`) and the desktop renderer. FEA-1510 / PLN-810. See
`README.md` for the human-facing overview and the full list of files that stay
in `apps/app`.

## Orientation

- Code is organized by feature slice under `packages/app/<feature>/`.
- Cross-feature utilities live under `shared/`.
- Web and desktop shells inject platform-specific ports for auth, navigation,
  feature flags, API access, and query behavior.

## Related

- `packages/app/AGENTS.md` — package rules for agents
- `packages/app/README.md` — migration context and package overview
- `apps/app/CLAUDE.md` — Next.js shell context
