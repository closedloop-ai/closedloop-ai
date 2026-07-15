# Desktop Collectors & Parsers — Agent Guide

> **Read `apps/desktop/AGENTS.md` first** for the app-wide rules (SQLite dialect, versioning, prebuild). This file is the **map + minefield guide** for the multi-harness ingestion layer under `collectors/` and its write path in `database/write-core.ts`. It captures the non-obvious model and the invariants that are cheap to break and expensive to rediscover — not a restatement of the code.

## Mental model (the 60-second version)

- A generic **`CollectorManager`** (`engine/collector-manager.ts`) drives **five thin harness collectors** — `claude`, `codex`, `cursor`, `copilot`, `opencode`. Each collector is just: a `home` (path/env resolution) + a `parser` (raw format → `NormalizedSession`) + a small descriptor. All harness-specific logic lives in those two files; the engine is harness-agnostic.
- Every parser emits **one `NormalizedSession`** (contract in `types.ts`) → `importer.importSession` (`database/write-core.ts`) → SQLite rows. `importSession` **consumes the session read-only** — it never mutates it.
- Ingestion runs as **boot import + a live channel**. The live channel per harness (hooks vs. file-watcher) is chosen by a single source of truth — see below.

## ⚠️ Invariants you must not break

1. **Collection-mode is a SSOT.** `engine/collection-mode.ts:getActiveCollectionMode(harness)` is the *only* place that decides hooks-vs-watcher. **Claude** = `hooks` when its hook config is installed, else `watcher`. **Every other harness is always `watcher`** — Codex hooks were removed (PRD-431); `handleHook`/`processEvent` are **Claude-only** (`harness: HookHarness`, the literal `"claude"`). Never reintroduce an inline `hooksInstalled` conditional at a call site, and never claim in a comment that a non-Claude harness has a hook path.
2. **Two readers parse the Claude transcript, and they drift.** `claude/claude-parser.ts` (the collector) and `database/transcript.ts` (the live-hook token extractor) both read Claude `.jsonl` and **diverge** (cached-input subtraction, subagent attribution, per-turn granularity). **If you change token or attribution logic, change both** — otherwise you introduce silent, hard-to-spot drift between the boot-import and live-hook paths.
3. **`importSession` is idempotent — keep it that way.** Deterministic ids (`deterministicEventId`, `mainAgentId`, `artifactIdFromIdentityKey`), delete-then-reinsert per record group, an FK-parent gate (session+main-agent must commit first), and an up-front unsafe-token skip (FEA-2027). Reparse, catch-up, and `DATA_REVISION` rebuild must all converge on the same rows. `billing_mode` and `name` are **COALESCE-guarded (sticky)** — the first real value wins and a later re-import won't clobber it.

## Per-harness cheat sheet (population + token strategy)

| Harness | Source / entrypoint | Drops session (→`[]`) | Token strategy | Notable fills / omissions |
|---|---|---|---|---|
| `claude` | one `.jsonl` / hooks **or** watcher | no timestamp | **dedup** (fold-dedup-map; avoids 2.8–68× inflation) | fills ~everything incl. `teams`, `usageExtras`, `slashCommands`, `compactions`, `slug`, `permissionMode`, `diffStats`, `subagents` (sidechain **+** sidecar `agent-*.jsonl`) |
| `codex` | rollout `.jsonl` (+ descendants folded) / watcher | **child rollout**, **burst session**, no timestamp | cumulative→**delta** + burst-drop + fork-replay dedup + workflow-journal merge + child-rollout fold | **only harness that fills `plans`**; `diffStats` (apply_patch); `subagents` = folded descendant rollouts. **No** `slug`/`teams`/`usageExtras`/`compactions`/`slashCommands`/`permissionMode` |
| `cursor` | transcript dir / watcher | no timestamp | **last-wins overwrite**, single key | **No** `diffStats`, `subagents`, `plans`, `slug`, `permissionMode`, … |
| `copilot` | chat `.json` **or** CLI `events.jsonl` / watcher | no messages / no timestamp | verbatim, single key | dual on-disk format; `toolResultErrors` **always `[]`** (errors ride `toolUses[].isError`); no `gitBranch`/`diffStats` |
| `opencode` | **batch** — whole `opencode.db` SQLite / watcher | zero messages / no timestamp; unchanged-DB fingerprint | column read (folds reasoning into `output`) | fills `slug`, `permissionMode`, `diffStats` from **DB columns** |

- The four non-Claude harnesses collapse to a **single `tokensByModel` key** with a `*-default` fallback (`cursor-default`, `copilot-default`, `opencode-default`; Codex → `gpt-5-codex` flagged `inferred`). Only Claude carries multiple model keys naturally.
- Codex is the only collector that **mutates the session after parse** (`foldCodexDescendants` folds child rollouts' tool-uses/tokens/series into the root and recomputes artifacts).

## Tokens, cost, and billing

- **`genai-prices` is authoritative** for pricing. The `model_pricing` and `pricing_rules` tables are **dead** — never read or write them.
- **`billing_mode`** (`shared/billing-mode.ts:detectBillingModeForHarness`) is detected at **ingest** from the machine's credential **existence** (env var non-empty / credential file present) — it **never reads secret contents**. It is COALESCE-**sticky**, and maps to a ledger (`metered` | `subscription` | `unknown`) where **headline cost EXCLUDES subscription** (subscription usage is a hypothetical "would-have-cost"). The engine is **twinned** with the agent-monitor sidecar (`scripts/agent-monitor-billing/billing-mode.js`) and guarded by a parity test — keep both in sync.

## ⚠️ Dead / write-only — do NOT trust these as populated

Wiring a new reader to any of these is a trap; they hold no reliable data.

- **OTLP path is unwired at runtime.** The receiver decodes, ACKs, and **logs only** (`onClaudeExport`/`onCodexExport`). The persisters exist but nothing in production writes through them: `persistClaudeCodeOtelSignals` has **zero callers**, and `persistCodexOtelBatch` **is** imported and called by the `db.codexOtel.persistBatch` facade method (`sqlite.ts`) — but that method has **no production callers** (only tests). So `codex_trace_span`, `claude_code_cost_event`, `claude_code_permission_event`, and `claude_code_api_request` are **never written** (FEA-1842/1843/1844 shipped log-only callbacks + unwired persisters). Note: don't delete the `persistCodexOtelBatch` import as "unused" — `sqlite.ts` references it; the dead-ness is at the *facade-caller* level, not the function level.
- **Rollups are effectively write-only.** `session_analytics` — only `session_id`, `is_human`, `started_at` are read (autonomy + heatmap + earliest-date); the rest is write-only. `session_tool_analytics` and `session_activity_segments` are **fully write-only**. Dashboards recompute live from `events` / `token_usage`.
- Also dead/dormant: `pull_request_status_observations`, `model_pricing`, `pricing_rules`, `pr_backfill_seen`.

## `metadata` blob & cloud sync

- `sessions.metadata` (`buildImportMetadata`) is an **unindexed JSON blob** of **18** `NormalizedSession` keys (`version`, `slug`, `gitBranch`, `userMessages`, `assistantMessages`, `entrypoint`, `permissionMode`, `thinkingBlockCount`, `teams`, `plans`, `usageExtras`, `compactions`, `messages`, `tokenSeries`, `diffStats`, `slashCommands`, `artifacts`, `parseQuality`). Only a handful are read locally; the rest ride to the cloud — except `tokenSeries`, stripped before sync (see below).
- **`tokenSeries` is stripped before cloud sync** (`OMITTED_SYNC_METADATA_KEYS`) and `messages`/event `data` are compacted. The cloud `SessionDetail` upsert **promotes ~40 trace fields to real columns** (`toTraceDetailPatch`) and stores the compacted blob verbatim.

## Transcript record reference (Claude)

- **Schema:** `claude/claude-session.schema.json` (JSON Schema draft 2020-12; validated with 0 violations across the local corpus). Update it if you add/see a new record shape.
- **`message.usage` only appears on `assistant` records** — one logical block per API turn, but physically **duplicated across the turn's streamed lines** (same `message.id`+`requestId`). This is the entire reason the dedup path exists; never sum raw usage.
- **`type:"user"` is overloaded.** It carries genuine human turns **and** synthetic ones — tool-result-only turns, `isMeta` (slash-command expansions), `isCompactSummary`, and `origin.kind` notifications. `handleUserEntry` counts only genuine human turns (FEA-2192); a slash-command's *raw* invocation counts (and yields a `slashCommands` entry via `<command-name>` tags), its `isMeta` expansion does not.
- **Records the parser ignores** (present in schema, not consumed): `ai-title` (`aiTitle` — the session's display title), `last-prompt`, `file-history-snapshot` (rewind/checkpoint file backups), `mode`, `pr-link`, `queue-operation`. `toolUseResult.resolvedModel` (the concrete model a subagent ran on, e.g. `claude-opus-4-8[1m]`, `claude-haiku-4-5`) is also present but unread.
- **`permissionMode` is a *field*, not an ignored record.** No record *type* is handled for it, but the `permissionMode` field — carried by session-start and `permission-mode`-typed records alike — is captured **first-wins** by the sticky common-metadata pass (`claude-parser.ts`: `if (!acc.permissionMode …)`), surfaced on `NormalizedSession.permissionMode`, and ridden to the cloud in `sessions.metadata`. Every occurrence after the first is dropped by that guard, so a later `permission-mode` record never overrides the first value seen.
- **`stop_reason`** values in transcripts: `tool_use`, `end_turn`, `stop_sequence`. `"error"` appears only in **hook** `Stop` data, not `message.stop_reason`.
- **`event_type` is NOT a closed enum.** `handleHook`'s `default` branch stores any raw hook name verbatim, so `events.event_type` can hold values beyond the ~13 the code explicitly produces.

## Where things live

`engine/collector-manager.ts` (engine) · `engine/collection-mode.ts` (**SSOT**) · `engine/catchup-cache.ts` (per-source cursor) · `types.ts` (`NormalizedSession` + `createNormalizedSession` defaults) · `<harness>/{-home,-parser,-collector}.ts` · `../database/write-core.ts` (`importSession` + phase functions) · `../database/transcript.ts` (the **other** Claude reader — the hook extractor) · `../../shared/billing-mode.ts`.
