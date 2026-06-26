/**
 * @file data-revision.ts
 * @description Versions the semantics of parser/import-derived DB rows (FEA-1785).
 *
 * Every session row is stamped with DATA_REVISION at import time. On boot, the
 * rebuild pass (data-revision-rebuild.ts) queries for sessions whose
 * data_revision differs from the current value, re-parses them from source
 * transcripts, and transactionally replaces the derived rows. Pre-existing rows
 * (before the data_revision column existed) carry the column DEFAULT of 1,
 * making them implicitly revision 1.
 *
 * Revision history:
 *   1 — implicit; pre-FEA-1785 rows (column DEFAULT).
 *   2 — FEA-1459 parser fix set: usage dedup, subagent merge, token_events,
 *       codex delta semantics, attribution audit corrections.
 *   3 — FEA-1787 deterministic event IDs: event row IDs change from randomUUID
 *       to SHA-256 hash of (sessionId, dedupKey). Rebuild required so cloud
 *       replacement triggers (cloud sees revision 3 != stored 2/NULL).
 *   4 — Claude parser now preserves string-form user message content instead
 *       of treating it as empty. Rebuild required so existing local/cloud
 *       Session Details stop showing role-label fallback text.
 *   5 — Local model pricing persistence adds derived token/session cost
 *       columns. Rebuild required so existing Codex/OpenCode sessions populate
 *       persisted estimates instead of relying on read-time fallback.
 *   6 — PR↔branch attribution fix: pull_requests.branch_name is now the head
 *       ref captured at `gh pr create` time for PRs the session CREATED, and null
 *       for merely-referenced PRs — no longer the session's stale start branch
 *       stamped on every touched PR. It is import-authoritative and the rebuild
 *       deletes+re-derives the per-session pull_requests rows, so it self-corrects
 *       on upgrade. Both branch surfaces source from it: the Branches view reads
 *       pull_requests directly, and the dashboard PR list (getPullRequests) now
 *       sources the displayed branch from pull_requests too (the COALESCE-
 *       accumulated artifacts.branch_name is NOT re-derived by the rebuild and is
 *       used only as a fallback for enrichment-discovered PRs with no import row).
 *   6 — FEA-2085: Codex model-less rollouts now key tokens under the priceable
 *       "gpt-5-codex" fallback (was the unpriceable "gpt-codex") and stamp
 *       token_usage.inferred. Rebuild required so existing model-less Codex
 *       sessions re-attribute, populate inferred, and finally price (closing
 *       the FEA-2082 token_cost.pricing_miss).
 *
 * Bump policy: increment DATA_REVISION whenever parser or import semantics
 * change in a way that should re-derive already-imported sessions from their
 * source transcripts. Sessions stamped with a stale value are rebuilt on the
 * next boot.
 *
 * Decoupling from PERSIST_VERSION (catchup-cache.ts): DATA_REVISION governs
 * DB-row re-derivation; PERSIST_VERSION governs the file-level catchup cache
 * (mtime/size fingerprints). Bump PERSIST_VERSION only when cache format or
 * fingerprint semantics change (forces a one-time full re-parse of files).
 * Bump DATA_REVISION only when the parse output semantics change (forces
 * re-derivation of stored rows from source transcripts). Their current
 * numerical equality is coincidence — they version independent concerns.
 */

export const DATA_REVISION = 6;
