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
  on `@repo/app`, `@repo/design-system`, `@repo/database`, or any app.
- **Consumed as source** (no build/`dist`). `apps/api` resolves it via the
  `@repo/* → packages/*` tsconfig path; the desktop main process needs it listed
  in `electron.vite.config.ts`'s `WORKSPACE_INLINE` + `workspaceAlias` so it is
  bundled from source rather than externalized (it has no `dist`/`exports`).
- **A module here is the SSOT for every surface that consumes it** — the harness
  transcript parser cores in `harness/` are run by both the desktop DB importer and
  the cloud session-detail renderer, so there is zero interpretation divergence by
  construction. Keep surface-specific shells out: desktop file I/O (readline
  streaming, sibling subagent-file / workflow-journal merges, mtime, env thresholds)
  stays in `apps/desktop/src/main/collectors/**` and composes these cores.
