# Desktop Collectors & Parsers — Agent Guide

> **Read `apps/desktop/AGENTS.md` first** for the app-wide rules (SQLite dialect, versioning, prebuild). This file is the **map + minefield guide** for the multi-harness ingestion layer under `collectors/` and its write path in `database/write-core.ts`. It captures the non-obvious model and the invariants that are cheap to break and expensive to rediscover — not a restatement of the code.

## Mental model (the 60-second version)

- A generic **`CollectorManager`** (`engine/collector-manager.ts`) drives **five thin harness collectors** — `claude`, `codex`, `cursor`, `copilot`, `opencode`. Each collector is just: a `home` (path/env resolution) + a `parser` (raw format → `NormalizedSession`) + a small descriptor. All harness-specific logic lives in those two files; the engine is harness-agnostic.
- Every parser emits **one `NormalizedSession`** (contract in `types.ts`) → `importer.importSession` (`database/write-core.ts`) → SQLite rows. `importSession` **consumes the session read-only** — it never mutates it.
- Ingestion runs as **boot import + a live channel**. The live channel per harness (hooks vs. file-watcher) is chosen by a single source of truth — see below.

## ⚠️ Invariants you must not break

1. **Collection-mode is a SSOT.** `engine/collection-mode.ts:getActiveCollectionMode(harness)` is the *only* place that decides hooks-vs-watcher. **Claude** = `hooks` when its hook config is installed, else `watcher`. **Every other harness is always `watcher`** — Codex hooks were removed (PRD-431); `handleHook`/`processEvent` are **Claude-only** (`harness: HookHarness`, the literal `"claude"`). Never reintroduce an inline `hooksInstalled` conditional at a call site, and never claim in a comment that a non-Claude harness has a hook path.
2. **Two readers parse the Claude transcript, and they drift.** `claude/claude-parser.ts` (the collector) and `database/transcript.ts` (the live-hook token extractor) both read Claude `.jsonl` and **diverge** (cached-input subtraction, subagent attribution, per-turn granularity). **If you change token or attribution logic, change both** — otherwise you introduce silent, hard-to-spot drift between the boot-import and live-hook paths.
3. **`importSession` is idempotent — keep it that way.** Deterministic ids (`deterministicEventId`, `mainAgentId`, `artifactIdFromIdentityKey`), delete-then-reinsert per record group, an FK-parent gate (session+main-agent must commit first), and an up-front unsafe-token skip (FEA-2027). Reparse, catch-up, and `DATA_REVISION` rebuild must all converge on the same rows. `billing_mode`/`model`/`cwd` are **COALESCE-guarded (sticky)** — the first real value wins and a later re-import won't clobber it. **`name` is NOT sticky (FEA-3578):** it takes the freshly-parsed value (`COALESCE($1, name)`) so a Claude session's harness `ai-title` (which the parser now uses as `name`, and which can change across syncs) propagates on re-import/rebuild. Non-Claude harnesses derive `name` deterministically from `cwd`, so refreshing re-writes the same value.

## Per-harness reference

The five-harness capability matrix (source/entrypoint, drop conditions, token
strategy, per-harness fills and omissions), the Claude transcript record
catalogue, and the full `sessions.metadata` key list live in
[`docs/runbooks/desktop-collector-harness-reference.md`](../../../../../docs/runbooks/desktop-collector-harness-reference.md).
Read it before adding a harness or wiring a reader to a `NormalizedSession` field.

## ⚠️ Traps

- **Codex and OpenCode mutate the session AFTER parse.** `foldCodexDescendants` folds child rollouts' tool-uses/tokens/series into the root and recomputes artifacts; since ISS-4544 `foldOpencodeSubagents` does the same for `parent_id`-linked OpenCode sessions. The remaining fold gaps in both — child `diffStats`, child events/metadata, and the hardcoded `status: "completed"` on a folded child — are tracked in ISS-4649 and are at PARITY between the two, so do not "fix" one lane alone.
- **A folded root's `tokenSeries` is NOT time-ordered.** Both folds APPEND the child's series after the root's own, so never read `tokenSeries.at(-1)` as "the latest record" (ISS-4649 finding 8; the null-model backfill picks by timestamp in `../database/session-model-backfill.ts`).
- **OpenCode parent linkage: use `readSessionParentLinks`**, which reports `Linked` / `Legacy` / `Unreadable` separately — never a bare empty-array fallback. It reads on a SECOND, independent SQLite connection, so a transient lock is not a legacy schema, and flattening on one would freeze an un-nested corpus behind the unchanged-DB fingerprint gate (ISS-4649).
- **The Claude delegation tool is named `Agent` in current transcripts and `Task` in older ones** — accept both when reconstructing the delegation kickoff (ISS-4592).
- **A NESTED delegation's tool_use lives in its parent SUBAGENT's transcript**, where the merged record is useless because `subagent-scanner` bounds each input at 1000 JSON chars — read the raw sidecar line instead.
- **Never sum raw `message.usage`.** It appears only on Claude `assistant` records, one logical block per API turn but physically duplicated across the turn's streamed lines (same `message.id` + `requestId`); that duplication is the entire reason the dedup path exists.

## Tokens, cost, and billing

- **`genai-prices` is authoritative** for pricing. The `model_pricing` and `pricing_rules` tables are **dead** — never read or write them.
- **`billing_mode`** (`shared/billing-mode.ts:detectBillingModeForHarness`) is detected at **ingest** from the machine's credential **existence** (env var non-empty / credential file present) — it **never reads secret contents**. It is COALESCE-**sticky**, and maps to a ledger (`metered` | `subscription` | `unknown`) where **headline cost EXCLUDES subscription** (subscription usage is a hypothetical "would-have-cost"). The engine is **twinned** with the agent-monitor sidecar (`scripts/agent-monitor-billing/billing-mode.js`) and guarded by a parity test — keep both in sync.

## ⚠️ Dead / write-only — do NOT trust these as populated

Wiring a new reader to any of these is a trap; they hold no reliable data.

- **OTLP path is unwired at runtime.** The receiver decodes, ACKs, and **logs only** (`onClaudeExport`/`onCodexExport`). The persisters exist but nothing in production writes through them: `persistClaudeCodeOtelSignals` has **zero callers**, and `persistCodexOtelBatch` **is** imported and called by the `db.codexOtel.persistBatch` facade method (`sqlite.ts`) — but that method has **no production callers** (only tests). So `codex_trace_span`, `claude_code_cost_event`, `claude_code_permission_event`, and `claude_code_api_request` are **never written** (FEA-1842/1843/1844 shipped log-only callbacks + unwired persisters). Note: don't delete the `persistCodexOtelBatch` import as "unused" — `sqlite.ts` references it; the dead-ness is at the *facade-caller* level, not the function level.
- **Rollups are effectively write-only.** `session_analytics` — only `session_id`, `is_human`, `started_at` are read (autonomy + heatmap + earliest-date); the rest is write-only. `session_tool_analytics` and `session_activity_segments` are **fully write-only**. Dashboards recompute live from `events` / `token_usage`.
- Also dead/dormant: `pull_request_status_observations`, `model_pricing`, `pricing_rules`, `pr_backfill_seen`.

## `metadata` blob & cloud sync

- `sessions.metadata` (`buildImportMetadata`) is an **unindexed JSON blob** of `NormalizedSession` keys (full list in the harness reference); most are read only by the cloud. `tokenSeries` is stripped before sync (`OMITTED_METADATA_KEYS`, `packages/lib/agent-sessions/metadata-preview.ts`) and `messages`/event `data` are compacted.
- The cloud `SessionDetail` upsert **promotes ~40 trace fields to real columns** (`toTraceDetailPatch`) and stores the compacted blob verbatim.

## Parser & import code conventions

Relocated from the root `AGENTS.md` (FEA-3894) — these apply specifically to collector/parser/import code:

- When parser or collector code folds child transcripts, sidechains, or subagent records into a parent session, preserve every downstream-owned projection input needed by later extractors and importers, including artifact refs, tool-use ownership, token attribution, and event de-duplication. Add regression coverage for the downstream consumer that would otherwise lose or duplicate the folded child data.
- When collector hooks run once per source during historical import or cache checks, precompute source-set metadata once per batch or collector instance instead of listing or reading all source metadata from each per-source hook. Test the structural property, such as dependency call counts or shared cache use, rather than wall-clock timing.
- In parser hot loops that accumulate events or tool uses, mutate the owned accumulator array with `push` instead of rebuilding it with spread or concat on every item. Copy arrays at ownership boundaries, not for append-only per-record ingestion.
- When folding child or sidechain transcripts requires deterministic data from a parent transcript, cache that parent-derived scan within the fold/import pass so siblings forked from the same parent do not repeat identical file I/O.
- When a collector merges the same provider entity from multiple connections, keep pagination/budget counters aligned with the final dedupe identity used for emitted records. Add overlap coverage so duplicate relationship paths cannot prematurely stop pagination or mislabel truncation.

## Where things live

`engine/collector-manager.ts` (engine) · `engine/collection-mode.ts` (**SSOT**) · `engine/catchup-cache.ts` (per-source cursor) · `types.ts` (`NormalizedSession` + `createNormalizedSession` defaults) · `<harness>/{-home,-parser,-collector}.ts` · `../database/write-core.ts` (`importSession` + phase functions) · `../database/transcript.ts` (the **other** Claude reader — the hook extractor) · `../../shared/billing-mode.ts`.
