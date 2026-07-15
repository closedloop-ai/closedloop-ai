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
 *   7 — FEA-2158: Claude and Codex native subagent linkage now derives
 *       parser-supplied agent hierarchy, native subagent metadata, and folded
 *       Codex child rollouts. Rebuild required so stale standalone child rows
 *       and anonymous sidechain activity reclassify under parent sessions.
 *   8 — FEA-2177: PR branch attribution fix + capture-time branch validation.
 *       extractToolUsePrRefs no longer falls back to session.gitBranch for
 *       created PRs (was stamping the session start branch on every PR).
 *       Rebuild re-derives pull_requests rows with correct head branch (null
 *       from extractor, then enrichment fills from GitHub headRefName).
 *       Branch artifacts for FETCH_HEAD, origin/*, refs/*, bare SHAs are now
 *       rejected at capture time and marked NOT_ENRICHABLE at enrichment time.
 *   9 — FEA-2343: Codex tokensByModel now derived from summed per-turn deltas
 *       (tokenSeries) instead of the cumulative snapshot (latestTotals).
 *       Eliminates cumulative-vs-delta divergence on counter resets or
 *       subagent fold. Rebuild re-derives token_usage rows with correct
 *       delta-based values.
 *   10 — FEA-2381: Codex PR extraction now recognizes the
 *       `github__create_pull_request` tool-name form. Rebuild re-derives
 *       pull_requests rows so historical sessions populate PR references.
 *   11 — FEA-2641: genuine-human-turn classification. Claude parser stops
 *       recording scheduled-wakeup re-injections, <local-command-stdout>
 *       echoes, and teammate-message injections as role:"human" messages, and
 *       counts origin.kind === "human" entries as genuine typed prompts (the
 *       FEA-2192 guard previously dropped them); session_analytics
 *       is_human/human_turns now derive transcript-first via JSON (json_each
 *       over $.messages) instead of the '"human"' substring count. Rebuild
 *       required so historical sessions re-parse with the corrected message
 *       roles and reclassify.
 *   12 — FEA-2641: typed session-terminating commands (/exit, /quit) no longer
 *       count as human steering (PM ruling: a clean exit is not a human turn).
 *       Rebuild reclassifies sessions whose human_turns crossed the is_human
 *       threshold only because the kickoff prompt was followed by /exit —
 *       i.e. single-kickoff overnight runs stop painting the activity
 *       heatmap's Human series around the clock. Also heals DBs already
 *       stamped 11 by pre-ruling builds of this branch.
 *   13 — FEA-2641: Codex parser stops recording injected-context user
 *       messages (AGENTS.md instructions blob, <environment_context>) as
 *       role:"human" — a response_item user message counts only when Codex
 *       also emitted its event_msg/user_message twin (structural
 *       discriminator; rollouts without user_message events keep legacy
 *       behavior) — and captures session_meta.originator as the session
 *       entrypoint (codex_exec / claude-codex-exec vs codex-tui /
 *       codex_cli_rs / codex_vscode). Rebuild re-derives codex sessions'
 *       $.messages, $.entrypoint, and is_human so scripted `codex exec` runs
 *       (e.g. cron-scheduled PR reviews) stop counting as human-steered and
 *       stop painting the heatmap's Human series.
 *   14 — FEA-2907: Codex parser now derives a parse-quality signal
 *       (sessions.metadata.parseQuality: totalLines, malformedLines,
 *       truncatedFinalLine) at parity with the Claude parser (FEA-2771), and
 *       foldCodexDescendants folds each descendant rollout's parseQuality into
 *       the parent (additive line counts, OR'd truncatedFinalLine). Rebuild
 *       required so existing Codex sessions populate parseQuality instead of
 *       omitting it.
 *   15 — FEA-2905: Claude parser now folds each subagent sidecar transcript's
 *       malformed-line count into the parent session's parse-quality signal
 *       (a corrupt subagent line silently drops that turn's folded token usage,
 *       so it must be surfaced rather than masked as a clean parse). Rebuild
 *       required so existing Claude sessions with subagent sidecars re-derive
 *       parseQuality.totalLines/malformedLines including the subagent lines.
 *   16 — FEA-2958: OpenCode parser stops double-counting token usage in
 *       tokenSeries. A message's usage was pushed twice — once at the message
 *       level (pushMessageTokenSeries) and again from that message's step-finish
 *       parts (handleStepFinishPart) — and both flowed into token_events, which
 *       the Dashboard Token analytics SUM for per-model/per-day cost
 *       (getTokenAnalytics reads SUM(cost_usd_estimated) FROM token_events). A
 *       step-finish token push is now skipped when its owning message already
 *       contributed a message-level entry. Rebuild re-derives token_events for
 *       existing OpenCode sessions so historical analytics de-inflate.
 *   17 — FEA-2979: Codex parser now folds each companion workflow journal's
 *       (workflow-*.jsonl inner-agent token journal) malformed-line count into
 *       the parent session's parse-quality signal (a corrupt inner-agent line
 *       silently drops that turn's folded token usage, so it must be surfaced
 *       rather than masked as a clean parse — the FEA-2905 fix, applied on the
 *       Codex side). Rebuild required so existing Codex sessions with workflow
 *       journals re-derive parseQuality.totalLines/malformedLines including the
 *       workflow-journal lines.
 *   18 — FEA-3112: Claude parser now records `<local-command-stdout>` echoes
 *       (local command OUTPUT echoed back under the `user` role) as a
 *       role:"system" transcript message instead of dropping them. They are
 *       still excluded from human turns (isAutomatedPromptInjection), so
 *       is_human/human_turns are unaffected. Rebuild required so existing
 *       Claude sessions with such echoes re-derive $.messages and surface the
 *       previously-missing system output in the session-detail trace.
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

export const DATA_REVISION = 18;
