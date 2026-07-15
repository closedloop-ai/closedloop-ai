# @repo/lib — Shared surface-agnostic business logic

Pure, framework-free business logic that must be shared **outside a React
context** — across the web renderer (`apps/app`, desktop renderer), the cloud
BFF (`apps/api`), and the **desktop main process** (`apps/desktop/src/main`,
bundled by electron-vite).

Organized by domain/feature, mirroring `packages/app` (e.g. `branches/`,
`agent-sessions/`), but holding only the pure logic — never components or hooks.

## Hard rules

- **No React, no browser/DOM, no `server-only`, no Node built-ins that break in
  a browser.** This package is imported into the Electron **main process**,
  which deliberately cannot import `@repo/app` (a React/renderer package) — that
  guardrail is the whole reason this package exists. Keep every module a pure
  leaf so it tree-shakes cleanly on every surface. The no-Node-globals half is
  **structurally enforced**: `tsconfig.json` sets `"types": []` and the package
  carries no `@types/node`, so `process` / `Buffer` / `node:*` are undeclared and
  a browser-unsafe reference is a compile error here, not a review catch.
  (Universal Web APIs — `TextEncoder`/`TextDecoder`/`URL` — come from the `DOM` +
  `es2022` libs and stay available.) A module that genuinely needs a Node
  built-in belongs in the desktop main process, not here.
- **Depend only on other surface-agnostic packages** — `@repo/api` (types +
  projectors), `@closedloop-ai/loops-api` (pricing), and the like. Never depend
  on `@repo/app`, `@closedloop-ai/design-system`, `@repo/database`, or any app.
- **Consumed as source** (no build/`dist`). `apps/api` resolves it via the
  `@repo/* → packages/*` tsconfig path; the desktop main process needs it listed
  in `electron.vite.config.ts`'s `WORKSPACE_INLINE` + `workspaceAlias` so it is
  bundled from source rather than externalized (it has no `dist`/`exports`).

## Current contents

- `branches/merged-trace.ts` — cross-session branch merged-trace assembly
  (`buildMergedTrace`, `mapTurnItemToTrace`, idle synthesis). SSOT for the
  desktop single-player trace and the cloud org-aggregated branch trace.
- `harness/` — the harness transcript parser cores (FEA-2717). One parser per
  harness that the desktop DB importer and the cloud session-detail renderer
  both run, so there is zero interpretation divergence by construction. Pure
  over a JSONL **line iterable** (`AsyncIterable<string> | Iterable<string>`):
  `claude/parse-claude.ts` (`parseClaudeTranscript`), `codex/parse-codex.ts`
  (`parseCodexRollout`), plus the shared `types.ts` (`NormalizedSession`
  contract), `token-counts.ts`, `type-guards.ts`, `usage-dedup.ts`, and
  `parser-utils.ts`. All browser-safe — `truncateText` uses
  `TextEncoder`/`TextDecoder` (not `Buffer`), and no module imports a Node
  built-in. The desktop file-I/O shells (readline streaming, sibling
  subagent-file / workflow-journal merges, mtime, env thresholds) stay in
  `apps/desktop/src/main/collectors/**`, composing these cores.
