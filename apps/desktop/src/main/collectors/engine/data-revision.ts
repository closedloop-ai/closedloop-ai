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
 *   19 — FEA-3124: typed `/exit` and `/quit` count as human turns again,
 *       reversing revision 12's NON_STEERING_COMMANDS carve-out (ruling
 *       2026-07-16, PRD-526: userMessages is the mechanical count of records a
 *       human submitted; steering-vs-automation is the attribution layer's
 *       call). The revision-12 regression — a whole session painted Human on
 *       the heatmap — cannot recur for the heatmap/autonomy-trend consumers:
 *       those are per-turn + headless-guarded since FEA-2641 Fix 4. The
 *       session-level `is_human`/`human_turns` rollup
 *       (session-analytics-rollup.ts; synced as `isHuman`) DOES count typed
 *       /exit//quit again, so an INTERACTIVE
 *       kickoff-plus-/exit session can cross the human threshold — intended
 *       under the ruling (both records were typed at a keyboard); scripted/
 *       headless sessions stay excluded by the headlessMetadataSql guard.
 *       Rebuild required so existing Claude sessions with typed /exit//quit
 *       re-derive $.messages, userMessages, and the human_turns/is_human
 *       rollups.
 *   20 — FEA-3128: Claude parser now extracts harness-authored `pr-link`
 *       records into `NormalizedSession.prLinks` — the authoritative
 *       session→PR association signal written by the harness itself (distinct
 *       from `artifacts.prs` which is re-derived from tool-text heuristics).
 *       Extractor v15 adds `extractHarnessPrLinkRefs` pass with
 *       `harness_record` confidence (rank 5, above `mcp_call`). Rebuild
 *       required so existing Claude sessions with `pr-link` records populate
 *       `prLinks` and emit higher-confidence PR artifact refs.
 *   21 — FEA-3126: Codex parser no longer double-adds reasoning_output_tokens
 *       into output_tokens. In OpenAI/Codex token_count payloads,
 *       reasoning_output_tokens is a SUBSET of output_tokens (proven:
 *       input+output==total across all cumulative events). The parser was
 *       treating them as additive via outputWithReasoning, inflating per-model
 *       output totals and all downstream cost estimates. Rebuild required so
 *       existing Codex sessions re-derive tokensByModel, tokenSeries, and
 *       cost_usd_estimated with correct output counts.
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
 *
 * 22 — FEA-3125: codex assistantMessages now counts event_msg token_count
 *      records (billable API round-trips) instead of double-counting
 *      response_item + event_msg echoes. Eliminates phantom assistant
 *      turns on zero-output sessions.
 *
 * 23 — FEA-3127: Codex parser now maps context-compaction records into
 *      NormalizedSession.compactions. A modern rollout records one compaction
 *      as a PAIR — a top-level `compacted` record (with replacement_history)
 *      followed milliseconds later by an `event_msg`/`context_compacted`
 *      echo — which counts once; either shape alone still counts. Compacted
 *      Codex sessions were previously indistinguishable from uncompacted
 *      ones downstream (compactions always [], no Compaction events, session
 *      lifecycle classification blind — TC-012). Rebuild required so
 *      existing compacted Codex sessions re-derive $.compactions and emit
 *      Compaction events.
 *
 *   24 — FEA-3496: Claude parser now captures the `cache_creation` TTL breakdown
 *      (ephemeral 5m vs 1h input tokens) into session `usageExtras`, summed over
 *      the same deduped turns as `cache_creation_input_tokens` (a subdivision of
 *      that total, never additive) and, on the desktop lane, including folded
 *      subagent-sidecar cache-creation. The breakdown is persisted in the session
 *      metadata blob. Rebuild required so existing Claude sessions re-derive
 *      `usageExtras.cache_creation` instead of carrying the zeroed placeholder.
 *
 * 25 — FEA-3153: Codex parser now maps `tool_search_call` records into one
 *      `NormalizedToolUse` named `tool_search` while leaving the catalog-style
 *      `tool_search_output` unassociated. Rebuild required so historical Codex
 *      sessions re-derive tool activity and agent-component usage counts.
 *
 * 26 — FEA-3525: Codex parser now captures the model context-window size
 *      (`model_context_window`, emitted on `token_count.info` and on
 *      `event_msg`/`task_started`) into NormalizedSession.modelContextWindow,
 *      and buildImportMetadata persists it under sessions.metadata. The field
 *      is only written when buildImportMetadata runs, so Codex sessions
 *      imported before this revision keep omitting it even though their source
 *      rollouts carry the window. Rebuild required so existing Codex sessions
 *      re-derive metadata.modelContextWindow from their transcripts and
 *      downstream consumers can compute context-window utilization.
 *
 * 27 — FEA-3420: Claude subagent transcript discovery is now RECURSIVE. Claude
 *      workflow agents are stored under
 *      subagents/workflows/<workflow-id>/agent-*.jsonl; the old one-level
 *      readdir folded only DIRECT subagents/agent-*.jsonl children, so every
 *      nested workflow agent's tokens, token-series records, tool uses, model
 *      attribution, and folded cache-creation breakdown were absent from the
 *      parent session (a session's `claude-sonnet-*` row could be missing
 *      entirely and its Opus row under-counted). Nested files now fold into the
 *      parent exactly once under a stable `subagents/`-relative identity
 *      (`workflows__<id>__agent-*`) that cannot collide with an identically
 *      named agent in another workflow. Rebuild required so retained Claude
 *      sessions re-derive per-model totals, tool activity, and costs including
 *      their nested workflow agents.
 *
 * 28 — FEA-3608: Codex `rebaseReplayedBurst` now decrements assistantMessages
 *      by the number of replayed burst `token_count` EVENTS, not the number of
 *      removed `tokenSeries` entries (FEA-3439). The removed-entry count
 *      UNDER-counted whenever a replayed burst event had a zero delta
 *      (cumulative unchanged) or no own timestamp: `assistantMessageCount++`
 *      runs for every extractable `token_count` event, but `tokenSeries.push`
 *      runs only when `iso && hasTokens`, so such an event inflated the count
 *      with no matching entry to remove. Rebuild required so resumed/forked
 *      Codex sessions whose leading burst carried a zero-delta or deferred
 *      round-trip re-derive assistantMessages (and session-trace `turns`) in
 *      alignment with the rebased token totals.
 *
 * 29 — FEA-2927: Claude parser `isAutomatedPromptInjection` now detects
 *      `<system-reminder>` blocks in user entries. Entries composed entirely
 *      of system-reminder content (MCP server instructions, deferred tool
 *      schemas, task reminders, auto-memory, hook output) are no longer
 *      recorded as `role:"human"` messages. Rebuild required so existing
 *      sessions re-derive userMessageCount, human-turn rollups, prompt
 *      timestamps, and autonomy scores without phantom human turns.
 *
 * 30 — FEA-3591: recomputeSessionLastActivityAt now floors last_activity_at at
 *      started_at, so the denormalized cursor sort key can never precede the
 *      session start. Resumed/continued runs that inherited pre-start events
 *      from a parent transcript had last_activity_at land hours before
 *      started_at (63 rows in the 2026-07-20 curation sweep), violating the
 *      `last_activity_at >= started_at` invariant the cloud read path documents
 *      and — via FEA-3580's endedAt = last_activity_at derivation — producing
 *      negative durations. Rebuild required so existing sub-started_at rows
 *      re-derive the floored value (they heal on the next data-revision rebuild).
 *
 * 31 — FEA-3578: Claude parser now consumes the harness-authored `ai-title`
 *      record and uses it as the session `name` (last non-blank wins), falling
 *      back to the cwd-derived name only when no title was emitted. The AI title
 *      is the label users recognize from the Claude Code UI. Rebuild required so
 *      existing Claude sessions whose transcripts carry `ai-title` records
 *      re-derive `name` (→ synced to `Artifact.name`) from the title instead of
 *      the cwd basename. Codex is unaffected (no `ai-title` equivalent).
 *
 * 32 — FEA-3713: Codex parser now records `parseQuality.unknownRecords` — the
 *      count of syntactically valid JSON records the classifier could not route
 *      to any handler (`kind:"other"`, the `dispatchLine` default that silently
 *      dropped the record). A valid record the parser doesn't understand was
 *      previously ignored without lowering any parse-quality signal; it is now
 *      surfaced. The field is emitted only when non-zero (clean rollouts and the
 *      Claude core omit it, so their metadata blobs stay byte-identical), and
 *      fork-descendant counts fold into the root via mergeParseQuality. Rebuild
 *      required so existing Codex sessions carrying unrecognized records
 *      re-derive `metadata.parseQuality.unknownRecords`; sessions with none
 *      re-derive to an identical blob.
 *
 * 33 — FEA-3682: Codex `rebaseReplayedBurst` now rebases
 *      `reasoning_output_tokens` in lockstep with the leading-burst token-event
 *      filtering that rebases the output total. `reasoningOutputTokens` is a
 *      whole-file cumulative MAX, so a resumed/forked session left the replayed
 *      parent's reasoning in it while the output total was rebased to a
 *      burst-relative delta — the surfaced `reasoning_output_tokens` could then
 *      EXCEED the session's own output (breaking the FEA-3527 subset invariant)
 *      and double-count the parent's reasoning. Rebuild required so existing
 *      resumed/forked Codex sessions re-derive `usageExtras.reasoning_output_tokens`
 *      as a burst-baseline delta instead of the over-counted cumulative max.
 *
 * 34 — FEA-3702: Codex parser now preserves the last-good `rate_limits` snapshot
 *      when a `token_count` event carries a present-but-malformed `rate_limits`
 *      block. A window with no usable telemetry (a non-object, or every field
 *      all-null) is rejected as invalid, and a valid partial window is merged
 *      over last-good rather than replacing the whole snapshot — so a malformed
 *      partial event can no longer blank a previously-captured `primary`/
 *      `secondary` sibling in the persisted `codexRateLimits` snapshot. Each
 *      present-but-malformed record is additionally counted in
 *      `parseQuality.malformedRateLimits` (stamped only when nonzero). Rebuild
 *      required so existing Codex sessions whose rollouts contained a malformed
 *      rate-limit window re-derive the preserved snapshot instead of the zeroed
 *      value, and surface the data-quality signal. Sessions with no malformed
 *      block round-trip unchanged.
 *
 * 35 — Bug 019f881c: the transcript-import path (`importToolEventData`) now
 *      persists each tool call's raw per-call input and result under the same
 *      `tool_input`/`tool_response` keys the live-hook path delivers, for ANY
 *      input shape (object, string, OR array). Previously it spread only object
 *      inputs to top-level `data` keys and dropped the output entirely, so every
 *      transcript-collected tool row rendered "No detail captured for this call"
 *      in the Session Trace, and string/array inputs (e.g. codex `bash`) carried
 *      no detail at all. The raw input is no longer ALSO flat-spread to
 *      top-level keys, so the analytics-only base and the size-cap on the heavy
 *      detail keys both hold. Rebuild required so already-imported sessions
 *      re-derive `data.tool_input`/`data.tool_response` and their expandable
 *      tool rows show captured detail.
 *
 * 36 — FEA-3668: every parser now skips non-meaningful `cwd` values
 *      (`isMeaningfulCwd`) when capturing a session's working directory — the
 *      filesystem root `/` (and bare Windows drive roots) above all. Automated
 *      launches whose process cwd is `/` recorded `/` as the session cwd before
 *      the agent cd'd into the real worktree, which mis-derived the repository to
 *      the bogus "/". The FIRST meaningful cwd now wins (else null → repo
 *      "Unknown"). Rebuild required so existing sessions re-derive cwd, name, and
 *      repository attribution off the real working directory.
 *
 * 37 — FEA-3728: the OpenCode and Copilot parsers no longer fold
 *      `reasoning_output_tokens` into `output`. That field is the OpenAI/Codex
 *      subset of `output_tokens` (proven in FEA-3126/FEA-3527) — already inside
 *      the output figure — so folding it double-counted reasoning into output and
 *      inflated cost for any OpenAI-backed OpenCode/Copilot session whose payload
 *      reported it (the same class as the confirmed Codex bug). It was dropped
 *      from the additive reasoning alias list; the genuinely-separate
 *      `reasoning`/`reasoning_tokens`/`tokens_reasoning` aliases still fold.
 *      Rebuild required so affected OpenCode/Copilot sessions re-derive
 *      tokensByModel, tokenSeries, and cost_usd_estimated with correct output
 *      counts; sessions with no `reasoning_output_tokens` round-trip unchanged.
 *
 * 38 — FEA-3419: cache-write TTL typed promotion + per-event 1h pricing. The
 *      Claude parser now carries the ephemeral 5m/1h cache-write split as typed
 *      `cacheWriteTtl` fields on tokensByModel and tokenSeries (validated
 *      all-or-absent at recordUsageLine; NULL = never reported), persisted into
 *      the new token_usage/token_events `cache_write_5m/1h_tokens` columns, and
 *      priced PER EVENT at 2x base input via estimateTokenCost. The FEA-3496
 *      session-level `usageExtras.cache_creation` blob is REMOVED from the
 *      parse output and metadata, and the FEA-3636 session-rollup premium term
 *      is deleted (it double-counts once events carry the premium). Rebuild
 *      required so retained sessions re-derive the typed split from source and
 *      re-bake TTL-correct per-event/per-model dollars (rev-24..37 rows hold
 *      the metadata but 5m-rate dollars); unretained blob sessions converge via
 *      healSessionRollupAfterTtlPremiumRemoval.
 *
 * 39 — FEA-3294: durable per-invocation component attribution. This revision
 *      is a deterministic stored-row migration, not a parser migration: it
 *      reconstructs invocation rows from the already-persisted events, agents,
 *      and session metadata, rebuilds the compatibility aggregate, and queues
 *      the dedicated invocation generation atomically. It deliberately does
 *      not read transcripts, the network, or current definition files, so
 *      missing/corrupt sources cannot prevent convergence or fabricate exact
 *      historical evidence. The revision stamp commits only with all derived
 *      writes; failure preserves both the prior projection and stale stamp.
 *
 *   40 — FEA-4093: the Claude parser now captures first-class Hook firings from
 *      transcript `attachment` records (`hook_success` / `hook_error` /
 *      `hook_non_blocking_error`) into `NormalizedSession.hooks`, and the
 *      invocation materializer emits one `Hook` component invocation per
 *      firing. Before this, hook firings were dropped entirely and every Hook
 *      component aggregated to zero usage. Unlike revision 39 (a transcript-free
 *      stored-row rebuild), this revision must re-derive from the SOURCE
 *      transcript — the hook `attachment` records live only in the raw JSONL, so
 *      a stored-row rebuild cannot recover them. Retained Claude sessions with a
 *      surviving transcript re-parse via the normal harness rebuild path and
 *      populate Hook usage. Sessions whose transcript is gone keep the stored-row
 *      invocation bridge (it stays on for every revision at/after
 *      COMPONENT_INVOCATION_STORED_REBUILD_REVISION) so they retain their
 *      non-hook invocations; hooks simply never appear for a transcript-less
 *      session. Non-Claude sessions re-derive to an identical set (they emit no
 *      hooks).
 *
 *   41 — FEA-4183: the OpenCode parser now (a) captures message/step token usage
 *      that carries real counts but NO resolvable model under the synthetic
 *      `opencode-default` key instead of dropping it, and (b) falls back to
 *      summing that token series into `tokensByModel` when the session-row
 *      aggregate columns are empty. `importPhaseTokenUsage` writes `token_usage`
 *      (and thus the authoritative `sessions.cost_usd_estimated` rollup, which
 *      `updateSessionCostRollup` derives EXCLUSIVELY from `token_usage`) from
 *      `tokensByModel` — so before this fix, an OpenCode session whose usage
 *      lived only in message rows recorded zero tokens and a null cost. Rebuild
 *      required so retained OpenCode sessions with a surviving `opencode.db`
 *      re-derive `tokensByModel`, `token_usage`, and a non-zero
 *      `cost_usd_estimated`. Sessions whose store is gone are left untouched.
 *
 *   42 — FEA-4184: activity-segment reprocessing for the harnesses the
 *      classifier-version backfill cannot reach. Bumping ACTIVITY_CLASSIFIER_VERSION
 *      to 6 re-tiles sessions via `activity-segment-backfill.ts`, but that backfill
 *      enumerates only `BUILTIN_TRANSCRIPT_SOURCES` (Claude/Codex/Cursor JSONL) —
 *      Copilot (dual-format on-disk) and OpenCode (batch SQLite store) are not in
 *      that list, so their sessions would keep stale v5 segments after upgrade.
 *      This DATA_REVISION bump routes EVERY harness through the collector-driven
 *      data-revision rebuild (`rebuildSessionFromParse`, which re-runs
 *      `classifyActivitySegments` at the current version) — including OpenCode via
 *      its `listSourcesForRebuild` bypass and Copilot via its unmapped-source
 *      reparse — so Copilot/OpenCode v5 segments are re-derived to v6. A
 *      deterministic re-tile with no parser-output change for Claude/Codex/Cursor
 *      (already re-tiled by the classifier backfill), so it is idempotent there.
 *
 *   43 — FEA-4187: terminal-status classification now records a run that ended on
 *      an unrecovered API error as ERROR instead of COMPLETED at import time
 *      (see imported-session-status.ts / write-core.ts). Sessions imported
 *      before this revision stored such failed runs as COMPLETED; the existing-
 *      row import path only recreated their main agent and never re-classified.
 *      Bumping forces the rebuild pass to re-parse each stale session from its
 *      source transcript and run the healed reconciliation branch, so a
 *      previously-mislabeled failed run flips COMPLETED → ERROR (and a correctly-
 *      classified ERROR run can never be resurrected as COMPLETED). Sessions
 *      whose transcript is gone are left untouched by the rebuild.
 *
 *   44 — FEA-4010: activity-segment reprocessing for the harnesses the
 *      classifier-version backfill cannot reach, paired with the
 *      ACTIVITY_CLASSIFIER_VERSION 6 → 7 bump (the vocabulary-free AA-01/05/11/12
 *      tranche). Those changes are harness-blind — they re-tile Copilot/OpenCode
 *      output too — but the segment backfill enumerates only
 *      `BUILTIN_TRANSCRIPT_SOURCES` (Claude/Codex/Cursor), so without a
 *      DATA_REVISION bump Copilot/OpenCode would keep stale v6 segments after
 *      upgrade (same gap FEA-4184 revision 42 covered for its v5 → v6 bump). This
 *      bump routes every harness through the collector-driven rebuild
 *      (`rebuildSessionFromParse`, which re-runs `classifyActivitySegments` at the
 *      current version), so Copilot/OpenCode v6 segments re-derive to v7. A
 *      deterministic no-op for Claude/Codex/Cursor (already re-tiled by the
 *      classifier backfill), so it is idempotent there.
 *
 *   45 — FEA-3942: the Claude parser now counts `MultiEdit` tool uses toward
 *      `diffStats`. Before this only `Edit`/`Write` contributed, so a session
 *      that edited files via `MultiEdit` under-reported (often to null) its
 *      per-session LOC. Like every diffStats change this must re-derive from the
 *      SOURCE transcript — the MultiEdit tool inputs live only in the raw JSONL —
 *      so retained Claude sessions with a surviving transcript re-parse via the
 *      normal harness rebuild path. Sessions whose transcript is gone, non-Claude
 *      sessions, and Claude sessions that never used MultiEdit re-derive to an
 *      identical diffStats. Sessions whose surviving transcript no longer parses
 *      to a valid session (a parser-output error) keep the shared stored-row
 *      invocation bridge stamp — the same terminal fallback every source-required
 *      revision uses — since an unparseable transcript can yield no diffStats at
 *      all; withholding the stamp would only re-parse a permanently-broken
 *      transcript on every boot.
 *
 *   46 — FEA-4376: the Claude parser now falls back to the human-readable model
 *      NAME echoed by a `/model` slash-command switch (`<local-command-stdout>Set
 *      model to <label></local-command-stdout>`) when a session recorded NO
 *      assistant `msg.model` to derive `session.model` from. Before this such a
 *      session reported "Unknown model" in Session Details even though the
 *      switched-to model was parseable from the transcript. An assistant API model
 *      id still wins when present, so sessions with any assistant record re-derive
 *      to an identical `model`; only assistant-less `/model`-switch sessions
 *      change. The label lives only in the SOURCE transcript, so this re-derives
 *      via the normal harness rebuild path. Non-Claude sessions and Claude
 *      sessions whose transcript is gone or no longer parses are unaffected.
 *
 *   47 — FEA-4010 (AA-03): the same Copilot/OpenCode routing for the
 *      ACTIVITY_CLASSIFIER_VERSION 7 → 8 bump (declared signals stop being a
 *      catch-all — an unrecognized command/skill/MCP call is now the inert
 *      `DeclaredUtility` instead of fabricating `declared` provenance and a
 *      confidence boost). Harness-blind, so Copilot/OpenCode segments change too,
 *      but the segment backfill still enumerates only `BUILTIN_TRANSCRIPT_SOURCES`
 *      (Claude/Codex/Cursor) — without this bump those two harnesses would keep
 *      stale v7 segments carrying the fabricated `declared` layer. Idempotent for
 *      the built-in harnesses, which the classifier backfill already re-tiled.
 *
 *   48 — ISS-4380: the OpenCode parser now reads the NESTED per-message/per-step
 *      cache-token shape real OpenCode emits — `data.tokens.cache.read` /
 *      `data.tokens.cache.write` — in `extractTokenCounts`. Only the flat
 *      `cache_read`/`cacheRead` aliases (which the SQLite `session` token columns
 *      use) were read before, so every message- and step-level token entry in
 *      `tokenSeries` recorded `cacheRead`/`cacheWrite` = 0, dropping all cache
 *      tokens from `token_events` (per-event cost, per-turn/activity-segment spend
 *      attribution) and from the FEA-4183 series-sum fallback for sessions with an
 *      empty session-row aggregate. Rebuild required so retained OpenCode sessions
 *      with a surviving `opencode.db` re-derive `tokenSeries` (and, for
 *      zero-aggregate sessions, `tokensByModel`/`token_usage`/`cost_usd_estimated`)
 *      with the nested cache tokens. Sessions whose store is gone are left
 *      untouched; sessions whose payloads used the flat shape round-trip unchanged.
 *
 *   49 — FEA-4010 (AA-04 / AA-09 C2): the same Copilot/OpenCode routing for the
 *      ACTIVITY_CLASSIFIER_VERSION 8 → 9 bump (a confidently read-only shell
 *      command refines to `ReadSearch`, making `explore` structurally reachable;
 *      an un-refined `RunCommand` no longer outvotes the mutation it accompanies
 *      nor adds AA-11 evidence mass). The SCORING half applies to every harness.
 *      The `ReadSearch` refinement, however, only reaches a harness whose adapter
 *      emits `RunCommand` — today Claude/Codex/Cursor. `copilotAdapter`
 *      categorizes every tool to `null` by design and `opencodeAdapter` resolves
 *      only its patch shape, so their shell work never enters the refinement and
 *      its investigation stays phase-neutral until those adapters surface shell
 *      tool uses (tracked separately; this revision does not heal it). The bump
 *      is still required for them, because the segment backfill enumerates only
 *      `BUILTIN_TRANSCRIPT_SOURCES`, so without it Copilot/OpenCode would keep
 *      stale v8 segments that the scoring change alone should have moved.
 *      Idempotent for the built-in harnesses, which the classifier backfill
 *      already re-tiled.
 *
 *   50 — FEA-3595: human-turn sentinel reclassification. The Claude parser now
 *      consumes a pending `<<autonomous-loop-dynamic>>` sentinel entry as a
 *      fallback when every exact-match ScheduleWakeup consume (raw text and
 *      reconstructed slash-command form) has already failed. This closes the
 *      gap where the sentinel's fire-time expansion — different text from the
 *      recorded prompt — was classified as a genuine human turn, pushing
 *      automated wg-review sessions over the `is_human` threshold. Sentinels
 *      are registered only for a ScheduleWakeup call whose tool_result
 *      succeeded, so a failed or canceled call can no longer swallow a real
 *      prompt. Rebuild required so existing misclassified sessions re-derive
 *      `human_turns` and `is_human` from their transcripts.
 *
 *   51 — FEA-4010 (AA-10): `work_item_ref` now resolves PER SEGMENT from the
 *      session's work-item MENTION stream, instead of projecting one
 *      session-level winner onto every segment. A session that works several
 *      artifacts is the normal case, so the old path reached its code-point
 *      tie-break on 11 of 24 golden sessions and stamped the alphabetically
 *      first slug — often one mentioned once, incidentally — across the whole
 *      tiling, idle spans included. Segment GEOMETRY is untouched: only the
 *      optional `work_item_ref` column is rewritten, so the PLN-1196 contract
 *      (identical geometry linked or not) still holds. The tiling itself does
 *      not change, hence no ACTIVITY_CLASSIFIER_VERSION bump — but
 *      already-imported sessions carry stale refs and re-stamp only through a
 *      re-import, which is exactly what this revision triggers.
 *
 *   52 — FEA-4010 (AA-09 C1): the same Copilot/OpenCode routing for the
 *      ACTIVITY_CLASSIFIER_VERSION 9 → 10 bump (a mutating tool use now refines
 *      by TARGET into `MutateCode` / `MutateDocument` / `MutateScratch`, and only
 *      a SOURCE mutation still scores full implement weight and vetoes `plan`).
 *      Both halves are harness-blind, so unlike revision 49 this reaches every
 *      harness whose adapter emits a mutation — but the bump is required for the
 *      same structural reason: the segment backfill enumerates only
 *      `BUILTIN_TRANSCRIPT_SOURCES`, so without it Copilot/OpenCode would keep
 *      stale v9 segments. `opencodeAdapter` does resolve a patch shape, so
 *      OpenCode genuinely re-tiles here; `copilotAdapter` categorizes every tool
 *      to `null` by design and is unaffected either way. Idempotent for the
 *      built-in harnesses, which the classifier backfill already re-tiles.
 *   53 — ISS-4447: propagate the FEA-3427 session wall-clock end-anchor fix to
 *      already-synced cloud rows. FEA-3427 corrected the derivation so the
 *      Session Detail "Duration" (`wallClock`) anchors on `ended_at` → last real
 *      activity → (only as a last resort) the mutable `updated_at`, and NEVER on
 *      a post-session re-sync `updated_at` bump. But it shipped WITHOUT a
 *      DATA_REVISION bump, and `wallClock`/`span` are sync-PAYLOAD projections
 *      (computed in `buildSessionTraceSyncFields` from the stored
 *      `ended_at`/`updated_at` + timeline/token activity — never persisted as a
 *      desktop row), so a session that was last synced under the OLD logic while
 *      `ended_at` was still null kept an `updated_at`-anchored value in the CLOUD
 *      that no incremental content-change ever refreshed (e.g. session
 *      019fa3f3-… read 73h — its `updated_at` re-sync time — versus the ~71.9h
 *      its `ended_at`/`last_activity_at` and event span all agree on). This bump
 *      forces the rebuild pass to re-visit every stale session and re-emit its
 *      sync payload, which recomputes `wallClock`/`span` from the corrected
 *      `ended_at`-first anchor. Deterministic and idempotent: the derivation is
 *      unchanged since FEA-3427, so a session already carrying the corrected
 *      value re-derives to an identical payload; only sessions still holding the
 *      old `updated_at`-anchored duration change. No parser-output change — this
 *      re-derives purely from stored session timestamps + activity, so it heals
 *      even sessions whose source transcript is gone (their child rows re-derive
 *      identically and the payload carries the corrected duration).
 *   54 — FEA-3943: the Codex parser now dedups `diffStats.filesChanged` by file
 *      path across `apply_patch` patches instead of summing each patch's file-
 *      header count. A Codex session that edits the same file in N patches
 *      previously inflated `filesChanged` by the repeats (lines added/removed
 *      were unaffected — those genuinely sum). Rebuild required so already-
 *      imported Codex sessions re-derive the distinct-file count from their
 *      source rollout; the corrected scalar rides to the cloud in
 *      `sessions.metadata.diffStats` on the next sync.
 *  55. FEA-4010 (AA-09 test detection) — `TestRun` now comes from parsing the
 *      command head rather than scanning the line for runner names, so
 *      `categoryMix` changes for any session that ran tests via a task name or a
 *      `--test` flag, or that merely read/linted a file whose name mentions a
 *      runner. Harness-BLIND (it reads normalized command text, not tool names),
 *      and the classifier-version backfill enumerates only
 *      `BUILTIN_TRANSCRIPT_SOURCES` (Claude/Codex/Cursor), so Copilot/OpenCode
 *      re-tile only through this collector rebuild — the same pattern as
 *      revisions 42/44/52. Note the AA-04 caveat still applies to those two
 *      harnesses (ISS-4422): they emit no `RunCommand`, so neither the explore
 *      refinement nor this one reaches their shell work at all.
 *  56. FEA-4010 (AA-06 + AA-07) — review-request and rework ENTRY detection are
 *      recalibrated (see ACTIVITY_CLASSIFIER_VERSION 12), so phase assignment and
 *      `evidence_layers` provenance change for sessions carrying a review-named
 *      command, a subagent-scoped skill, a re-run request, or a long autonomous
 *      kickoff. Harness-BLIND (it reads normalized message text and command
 *      names), and the classifier-version backfill enumerates only
 *      `BUILTIN_TRANSCRIPT_SOURCES`, so Copilot/OpenCode re-tile only through this
 *      collector rebuild — same pattern as revisions 42/44/52/55.
 *  57. FEA-4010 (AA-08) — subagent purpose takes the parent's declared phase as a
 *      prior (see ACTIVITY_CLASSIFIER_VERSION 13), so delegated spend inside a
 *      declared review re-files from `explore` to `review`. Harness-BLIND (it
 *      reads the normalized `subagents` contract), and the classifier-version
 *      backfill enumerates only `BUILTIN_TRANSCRIPT_SOURCES`, so Copilot/OpenCode
 *      re-tile only through this collector rebuild — same pattern as revisions
 *      42/44/52/55/56.
 *  58. FEA-4010 (AA-09 review follow-ups) — three command-lexing defects that
 *      each suppressed real test runs (see EVIDENCE_MODEL_VERSION 6 /
 *      ACTIVITY_CLASSIFIER_VERSION 14): a quoted heredoc opener that swallowed
 *      the commands after it, a here-string read as that opener, and a namespaced
 *      task name (`pnpm test:node`) discarded as a flag's value. Harness-BLIND
 *      (it reads shell command text, not any harness tool vocabulary), and the
 *      classifier-version backfill enumerates only `BUILTIN_TRANSCRIPT_SOURCES`,
 *      so Copilot/OpenCode re-tile only through this collector rebuild — same
 *      pattern as revisions 42/44/52/55/56/57.
 *  59. FEA-4010 (AA-09 review round 2) — inherited subagent labels carry the
 *      declaration's own confidence and the `declared` evidence layer, and the
 *      prior resolves at subagent entry (see ACTIVITY_CLASSIFIER_VERSION 15);
 *      plus three command-lexing gains (see EVIDENCE_MODEL_VERSION 7).
 *      Harness-BLIND, and the classifier-version backfill enumerates only
 *      `BUILTIN_TRANSCRIPT_SOURCES`, so Copilot/OpenCode re-tile only through this
 *      collector rebuild — same pattern as revisions 42/44/52/55/56/57/58.
 *  60. FEA-4010 (AA-09 review round 3) — the command splitter honours shell
 *      escape/comment state and four further reader fixes (see
 *      EVIDENCE_MODEL_VERSION 8 / ACTIVITY_CLASSIFIER_VERSION 16). Harness-BLIND,
 *      and the classifier-version backfill enumerates only
 *      `BUILTIN_TRANSCRIPT_SOURCES`, so Copilot/OpenCode re-tile only through this
 *      collector rebuild — same pattern as revisions 42/44/52/55/56/57/58/59.
 *  61. FEA-3597 — parsers emit ROUND-TRIP PROVENANCE: `NormalizedTokenRecord`
 *      gains an optional `subagentId`, so a folded subagent's token records are
 *      distinguishable from the parent's own at parse time. Both fold sites
 *      stamp it (Claude sidecars via the `extractDedupedUsage` file-authoritative
 *      override; Codex child rollouts inline at `foldCodexDescendants`), and
 *      Claude in-line sidechain records derive it per entry. A REBUILD is
 *      required because the marker exists ONLY at parse time: `$.subagents` is
 *      consumed and dropped at import (0 of 3,697 stored sessions retain it), so
 *      no write-path rule could ever recover the parent/subagent split from
 *      stored metadata — re-parsing from source transcripts is the only way to
 *      obtain it.
 *
 *      `session_turn_bucket` agent rows move onto that series in the same
 *      change: they were counted per `$.messages` assistant ROW (one per
 *      text/tool_use/thinking block), inflating the store ~3x against the
 *      canonical `$.assistantMessages` rollup (FEA-3125/FEA-3226); they now
 *      count PARENT-attributed `$.tokenSeries` entries, which IS the billable
 *      round-trip series. Human rows are untouched. Golden agent units
 *      4,677 → 1,788 across the corpus, human 109 unchanged, zero dossiers
 *      increasing. SUPERSEDED IN PART by revision 71 (ISS-5395): the move onto
 *      `$.tokenSeries` stands, the PARENT-only restriction does not.
 *
 *      Harness coverage: Claude and Codex carry provenance; OpenCode children
 *      stay separate sessions so its roots are parent-only by construction;
 *      Cursor and Copilot have no subagent concept in either parser or
 *      collector and are treated as all-parent (documented limitation).
 *      Sessions whose source transcript is gone cannot re-parse and keep
 *      pre-marker metadata, so their folded subagent work still reads as parent
 *      — enumerated rather than silently healed.
 *  62. ISS-4544 (Part 2 of ISS-4386) — the OpenCode collector now folds subagent
 *      sessions (rows carrying a `session.parent_id`) into their root parent's
 *      `subagents[]` at parity with the Claude/Codex sub-agent roll-up, instead of
 *      importing each child as its own standalone top-level session. The child's
 *      tool-uses/tokens fold into the root and each subagent nests as an `agents`
 *      row under the parent (identity = the child's raw opencode session id, a
 *      content-derived key per FEA-4335). Rebuild required so retained OpenCode
 *      sessions with a surviving `opencode.db` re-derive under the fold.
 *      CORRECTION (ISS-4649 finding 1): this entry originally claimed
 *      "previously-standalone subagent sessions collapse under their parent and
 *      disappear from the top-level list". That holds for sessions imported
 *      AFTER the fold, but NOT for rows an older build already stored as
 *      top-level. OpenCode is a BATCH collector, so the revision rebuild routes
 *      every source through `rebuildUnmappedSource`, which by design never
 *      deletes ("there is no positive source→id mapping to justify it"), and the
 *      only delete paths (`foldedChildSessionIds` and the empty-parse delete in
 *      `collector-manager.ts`) are gated on `sessionIdForSource` +
 *      `isBurstArtifactSource`, which batch collectors do not implement. A
 *      pre-fold `opencode-<childId>` row therefore SURVIVES the rebuild beside
 *      its now-folded root and is then sealed at the current revision. Pruning
 *      it needs a batch-collector-visible reconciliation keyed on the fold's OWN
 *      emitted child set — deliberately NOT derived from the raw `parent_id`
 *      column, because the fold intentionally re-emits an orphaned child (unknown
 *      or cyclic parent) as top-level, and `deleteSessionRow` cascades
 *      irreversibly across ~20 session-keyed tables. BUILT AT REVISION 71
 *      (ISS-5395): `pruneFoldedChildRows` runs on the unmapped/batch rebuild
 *      path and deletes exactly the ids the CURRENT parse folded, excluding any
 *      that came back as top level (so a re-emitted orphan is never pruned).
 *      WHAT A USER SAW UNTIL THEN, on a PRE-FOLD install only: the surviving
 *      `opencode-<childId>` row and the row now nested under its folded root are
 *      the SAME session, so one subagent appears TWICE — once as a top-level
 *      Sessions row and once inside its parent — and the top-level Sessions count
 *      is inflated by one per pre-fold subagent. Its tokens and cost fold into the
 *      root as well, so the standalone row is additionally double-counted by any
 *      all-sessions rollup that sums the top-level list. Naming that here so
 *      "my session total looks high" on an upgraded install is findable
 *      (closedloop-ai-stage, #4295). A fresh install, or one whose OpenCode rows
 *      were all imported after the fold, is unaffected.
 *      Sessions whose store is gone are left untouched; an
 *      OpenCode DB predating the `parent_id` column (empty linkage) re-derives
 *      unchanged (every session stays a root).
 *  63. ISS-4775 (Part 1) — the invocation materializer no longer emits a phantom
 *      `Command` component for a slash-invoked SKILL. Running `/cl-ci-babysit`
 *      (a skill) records BOTH a `<command-name>` slash entry and a `Skill`
 *      tool_use, so `commandCandidates` used to emit a Command candidate keyed
 *      `/cl-ci-babysit` alongside the resolved Skill candidate keyed
 *      `cl-ci-babysit`. No `.claude/commands/<name>.md` exists for a skill (its
 *      entrypoint is `SKILL.md`), so that Command candidate could never resolve
 *      and lingered as a phantom unresolved component (invocations split 4/4/0).
 *      `commandCandidates` now suppresses a command whose bare name matches a
 *      skill key the session invoked. Genuine non-skill commands still emit.
 *      Bumping re-derives already-imported sessions on next boot via the
 *      collector-driven rebuild so the phantom invocation rows stop being
 *      emitted; the leftover phantom `agent_components` rows themselves are
 *      cleaned by the Part-2 backfill (a separate follow-up). Sessions with no
 *      slash-invoked skill re-derive to an identical invocation set.
 *  64. ISS-4884 — Claude transcript entries whose `uuid` field is present but
 *      invalid now persist `malformed` source-identity evidence instead of the
 *      legacy `missing_source_record_id` classification. Rebuild retained
 *      Claude transcripts so identical source files converge regardless of
 *      whether they were imported before or after the provenance adapter.
 *  65. ISS-4810 / ISS-4811 — skill-shadow suppression becomes PER-OCCURRENCE and
 *      is applied on BOTH derivation paths. Revision 63 keyed suppression off
 *      SESSION-WIDE set membership, so a session with three `/foo` slash entries
 *      but only two `foo` Skill invocations (a `/foo` escaped before the Skill
 *      tool fired, or a live-watch import holding the `<command-name>` entry
 *      without its tool_use yet) dropped ALL THREE Command rows — an undercount
 *      swapped in for the old overcount, contradicting the three user turns the
 *      session trace derives. Each Skill invocation now claims AT MOST ONE slash
 *      invocation of its bare name (nearest preceding, else earliest unclaimed),
 *      so unpaired slash invocations survive (ISS-4810). The identical helper
 *      also runs inside the stored-row rebuild bridge, whose
 *      `storedCommandCandidates` previously emitted every metadata slash command
 *      while `storedEventCandidates` separately emitted the matching Skill row:
 *      transcript-less sessions (missing source / parser-output fallback — the
 *      largest ones) were reconstructed WITH the phantom Command and then
 *      stamped at 63, after which nothing selected them again, so two sessions
 *      that invoked the same skill showed different Skill/Command splits purely
 *      by whether their transcript survived (ISS-4811). Bumping re-selects those
 *      sealed sessions so the bridge re-derives them under the shared rule.
 *      Sessions whose slash/Skill occurrences already paired one-to-one — the
 *      common case, and every session with no slash-invoked skill — re-derive to
 *      an identical invocation set.
 *  66. ISS-4592 — the Claude subagent DELEGATION KICKOFF reaches the contract,
 *      and the duplicate row it exposed is retired. Two halves, one revision
 *      because they ship together:
 *      (a) The parser populates `type`/`task` plus
 *      `metadata.spawnedByToolUseId`/`metadata.description` on its subagent
 *      records, joined from the Agent/Task tool_result's `toolUseResult
 *      {agentId, agentType, prompt}` (inline lane) and the sidecar
 *      `agent-<hex>.meta.json` FK → tool_use input (desktop lane; nested
 *      delegations recover the prompt from sibling-sidecar `toolUseResult`
 *      lines). `matchSpawnedSubagent` gains a tier-0 exact spawn join so
 *      same-type siblings can never mispair by order.
 *      (b) The `agents` write path stops writing the `-sub-<toolUseId>` twin
 *      when a subagent record already claims that tool use. Both lanes had
 *      always written a row per real delegation; the parser row's previously
 *      null `subagent_type`/`task` merely made the pair distinguishable, and
 *      (a) would otherwise have turned it into a byte-identical duplicate that
 *      inflated every NAMED `subagent_type` bucket to ~2x its true value. The
 *      spawn event is re-pointed to the survivor rather than dropped, so event
 *      ids and counts are unchanged, and the survivor adopts the tool-use span
 *      when its own is degenerate so durations are not zeroed.
 *      Rebuild required so imported Claude sessions gain the kickoff and drop
 *      the duplicate rows. Sessions whose source transcript is gone keep
 *      pre-kickoff rows — enumerated, not silently healed. Delegations the
 *      parser lane never claimed (other harnesses, parses predating this
 *      revision) still write the fallback row, and sessions without delegation
 *      data parse byte-identically to revision-65 output.
 *  67. ISS-5238 (F5) — OpenCode `diffStats` stops trusting an unusable
 *      `summary_*` column. `resolveOpencodeDiffStats` now refuses the summary
 *      columns WHOLESALE (falling back to patch-accumulated stats, or to `null`
 *      when there are none) whenever any one of them is non-numeric, negative,
 *      or otherwise not a non-negative integer, instead of half-trusting the set
 *      and persisting a `NaN`/negative into `sessions.metadata.diffStats`. A
 *      `NaN` there serializes as `null` into the materialized projection, where
 *      the cloud's `diffStatsSchema` (`z.number()`) rejects the session header
 *      line and discards the ENTIRE session.
 *      Rebuild required: this is persisted parser output, so already-imported
 *      OpenCode sessions keep the bad diff stats until they re-derive (wongk
 *      review). Sessions whose `summary_*` columns were valid — the normal case
 *      — parse byte-identically to revision-66 output, and non-OpenCode
 *      harnesses are untouched.
 *  68. ISS-5260 — a slash invocation of a SKILL is attributed to the SKILL, so
 *      one entity keeps one record. Revisions 63/65 suppressed only the slash
 *      invocations that could be PAIRED with a `Skill` tool_use of the same bare
 *      name, and deliberately kept the unpaired ones so an escaped `/foo` was
 *      not silently deleted. But the dominant shape has nothing to pair with:
 *      Claude Code expands a slash-invoked skill without emitting a `Skill`
 *      tool_use at all, so `/code-review:deep` survived as a Command candidate
 *      and minted an `agent_components` row beside the resolved
 *      `skill:code-review:deep` row the definition collector had already
 *      written. Two records for one entity — invocations and modal usage on the
 *      command, the definition on the skill — so every per-component rollup
 *      (invocation counts, cost, LOC-per-dollar, catalog population) was wrong
 *      for exactly the skills people invoke by slash. An unpaired survivor whose
 *      bare name answers to a RESOLVED local skill is now RE-POINTED onto that
 *      skill rather than dropped, so the count still reconciles with the user
 *      turns it derives from (the revision-65 property) while landing on the one
 *      record that also holds the definition. A command with its own definition
 *      evidence — a resolving `definitionSnapshot`, a prior `definition_hash`,
 *      or a `.claude/commands/<name>.md` in the inventory — is never re-pointed,
 *      so a genuine `/deploy` beside a `deploy` skill keeps both records.
 *      Bumping re-derives sealed sessions through the shared rule; sessions with
 *      no slash-invoked skill re-derive to an identical invocation set.
 *
 *      KNOWN TRADEOFF, recorded here because this is where someone staring at a
 *      suspiciously high per-skill invocation count will look. This revision
 *      DELIBERATELY inverts a property ISS-4810 built: `claimPosition` refuses
 *      to pair a `/foo` typed at 10:05 forward onto a `foo` Skill that fired at
 *      10:00, and the slash entry it therefore cannot pair used to survive as a
 *      separate `command` row. That protected survivor is now re-pointed onto
 *      `skill:foo`, so it lands in the SKILL's rollup. When the survivor was an
 *      unlogged slash expansion — the dominant shape, since Claude Code emits no
 *      `Skill` tool_use for a slash-invoked skill — that is the correct reading
 *      and the whole point of the revision. When it was a `/foo` the user typed
 *      and ESCAPED before it ran, the skill now rolls up one invocation more
 *      than actually fired. The transcript records the two identically, so no
 *      rule can separate them. The call is deliberate: the escaped case is rare
 *      relative to the unlogged-expansion case, and it degrades to a modest
 *      per-skill overcount rather than the split-identity it replaced (where
 *      counts, cost, and the definition sat on two different records and
 *      reconciled against neither). It is an OVERCOUNT on the skill, not a stray
 *      `command` row — the shape to expect if a skill's invocation count reads
 *      higher than a user remembers running it.
 *
 *   69 — ISS-5236: `session_artifact_links.observed_at` is stamped from the
 *      source (the ref's own transcript event instant, else the session's
 *      `startedAt`) instead of the import wall clock. `EXTRACTOR_VERSION` 22→23
 *      re-derives links too, but through `artifact-link-backfill.ts`, which
 *      enumerates transcript FILES and therefore reaches only the three
 *      file-per-session harnesses it lists (`claude`, `codex`, `cursor`) — not
 *      `copilot` and not `opencode`, whose sessions live in one batch SQLite DB
 *      with no per-session transcript to enumerate — and which deliberately
 *      PRESERVES `launch_metadata` links (they are in
 *      `NON_REDERIVED_LINK_METHODS`) so those keep their import-clock instant.
 *      This rebuild is the harness-generic path: it iterates the `sessions`
 *      TABLE, so every harness with a surviving source is covered, and it
 *      re-imports through `importSessionWithTx`, whose artifact-links phase
 *      deletes and recreates the launch-metadata link with the corrected
 *      instant. Bumping is what actually converges the corpus and — via the
 *      restored `observed_at` column in the FEA-3659 child-row fingerprint —
 *      advances `updated_at` so the correction reaches the cloud instead of
 *      healing only local SQLite.
 *
 *  70. ISS-5099 — the invocation lane (`spawnedSubagentCandidates`) now pairs a
 *      delegating tool use with the parser subagent that exactly claims it
 *      (`metadata.spawnedByToolUseId`) BEFORE running the fuzzy
 *      `matchSpawnedSubagent` tiers, consuming the same
 *      `buildSubagentDedupIndex` correlation the `agents` write lane uses for
 *      revision 66's twin retirement. Before this, an earlier same-type tool
 *      use could greedily claim the subagent through the timestamp/type tiers,
 *      leaving the exactly-claimed later tool use to synthesize the retired
 *      `-sub-<toolUseId>` agent id (FK 787; since ISS-5098/#4355, a nulled
 *      `agent_id` instead). Rebuild required so sessions sealed with the
 *      mispair — cross-paired invocation rows, or #4355-window rows whose
 *      attribution was nulled — re-derive correct pairing. FK-failed sessions
 *      sit at the import-pending sentinel and self-heal regardless. Sessions
 *      whose claims already paired one-to-one re-derive identically.
 *
 *      MISSING-SOURCE sessions are repaired too, rather than sealed on the bad
 *      state (wongk review). Those sessions cannot be reparsed, so the bridge
 *      (`rebuildAgentComponentInvocationsFromStoredRows`) rebuilds subagent
 *      candidates from the surviving `agents` rows — which carry no delegation
 *      identity — and `restoreStableInvocationIdentities` used to copy the
 *      stored, cross-paired `provider_tool_use_id` straight back onto them
 *      before the bridge stamped this revision, at which point nothing selected
 *      the session again and the mispair (plus the nulled row's identity) was
 *      permanent. The pairing is instead recovered from the DURABLE
 *      `Agent`/`Task` spawn events, whose `agent_id` was re-pointed at the
 *      surviving parser row in revision 66 and whose payload carries the
 *      delegation's claim key (`applyStoredSpawnClaimKeys`), and the freshly
 *      derived value now wins over the stored one. So the bridge seals the
 *      CORRECTED pairing. A subagent whose spawn events disagree is left
 *      unclaimed, matching the trust-boundary rule the parser lane applies.
 *
 *  71. ISS-5395 — `session_turn_bucket` AGENT rows are derived from EVERY
 *      `$.tokenSeries` round-trip, not only the PARENT-attributed ones.
 *      Revision 61 (FEA-3597) added the `subagentId` marker and began SKIPPING
 *      every marked round-trip, on the reasoning that a folded subagent's work
 *      is not an agent turn on the parent's timeline. There is no other
 *      timeline: all three folding harnesses REMOVE the child from the
 *      top-level session list and fold it into its root parent, and the local
 *      `sessions` table has no `parent_id`, so those round-trips were LOST, not
 *      re-homed. A session that delegates most of its work therefore rendered
 *      as near-idle on the Insights autonomy trend and activity heatmap — on
 *      the live corpus, one produce-loop session had 13,589 of 14,226
 *      round-trips (95.5%) dropped, showing 97 turns for two days of driving
 *      four concurrent implementation lanes.
 *      WHAT A USER SEES AFTER THE REBUILD: the autonomy trend and the activity
 *      heatmap both rise on days that ran delegating sessions, because turns
 *      that were silently discarded now appear. That is a CORRECTION, not
 *      inflation — the round-trips were always billed and always in
 *      `token_usage`; only the per-turn materialization dropped them. A session
 *      that never delegates re-derives to a byte-identical bucket set, and a
 *      session with genuinely no round-trips still derives ZERO rows.
 *      Bumping re-derives already-imported sessions on the next boot; no
 *      re-parse is strictly required (the `subagentId` markers are already in
 *      the persisted metadata) but the revision rebuild is the one convergent,
 *      already-tested path to re-materialize the table, so it is used rather
 *      than a bespoke maintenance pass.
 *      UPGRADED-INSTALL RECONCILIATION (wongk review): counting the child's
 *      round-trips on the root is only a correction while exactly ONE bucket row
 *      exists per round-trip, and on a PRE-FOLD OpenCode install that invariant
 *      did not hold — revision 62 records that a standalone `opencode-<childId>`
 *      row SURVIVES beside its folded root, and that row derives its own buckets
 *      for the same round-trips. This revision therefore also builds the pruning
 *      revision 62 deferred: `pruneFoldedChildRows` (data-revision-folded-child-prune.ts)
 *      runs on the unmapped/batch rebuild path, keyed on the fold's OWN emitted
 *      child set (`subagents[].childSessionId`) rather than the raw `parent_id`
 *      column, and deletes the stale top-level row before the root is re-derived.
 *      It also clears the pre-existing session-count/token/cost double-count
 *      that entry named. RESIDUAL, stated rather than implied: a root whose
 *      OpenCode store has been REMOVED since it was last imported under the fold
 *      takes the missing-source path, where there is no parse to key on, so its
 *      surviving child row is not pruned and those days stay double-counted.
 *      Pruning that shape needs a store-independent key (the persisted
 *      `component_invocations.child_session_id`) and a new db hook, which is a
 *      separate change.
 *  72. ISS-5402 — a folded Claude sub-agent's authored LINES now roll up to the
 *      parent session's `diffStats`, closing the numerator/denominator asymmetry
 *      in `LOC / $`.
 *      The desktop sidecar merge has always folded a `subagents/agent-*.jsonl`
 *      child's TOKENS into the parent (`mergeFoldedUsage`) — which is why a
 *      delegating session's `est_cost` includes delegated work — but never its
 *      LOC. `session.diffStats` came from the core parser's own tool loop, which
 *      the sidecar records bypass by construction. So the ratio divided a cost
 *      that counted sub-agents into a line count that did not, understating it
 *      by exactly the delegation rate. Measured on the live desktop store, one
 *      produce-loop session showed 1,410 `Edit` + 334 `Write` invocations and
 *      302 sidecar transcripts against a persisted `filesChanged` of 19.
 *      This applies the SAME roll-up-to-parent model ISS-5395 established: a
 *      folded sub-agent has no session row of its own (no `parent_id` on the
 *      local `sessions` table), so there is no other timeline to attribute its
 *      lines to. Line deltas are routed through the shared
 *      `applyDiffStatsToolUse` registry — not a second formula — and read from
 *      the untruncated raw sidecar lines, because the merged tool-use records
 *      bound each input at 1000 JSON chars. `filesChanged` is a UNION over the
 *      parent's own changed paths and every sidecar's, so a file both touched
 *      counts once rather than twice.
 *      Rebuild required: this is persisted parser output, so already-imported
 *      sessions keep the parent-only LOC until they re-derive. A session with no
 *      sidecar subagents — and one whose sidecars only read — parses
 *      byte-identically to the pre-ISS-5402 output, and a session with no edits
 *      at all still persists `diffStats: null` rather than a fabricated zero.
 *      On sequencing: this bump originally read 70, which collided — `main` took
 *      70 for ISS-5099 (above) and ISS-5395 / PR #4519 claimed 71 — so it is
 *      renumbered to 72. Nothing is stranded by the renumber: the rebuild selects
 *      on `dataRevision: { not: currentRevision }` (`listStaleRevisionSessions`),
 *      an INEQUALITY rather than a `<`, so a store already stamped 70 or 71 still
 *      re-derives under any later constant.
 *  73. ISS-5426 — the revision-72 sidecar `diffStats` fold now counts a
 *      sub-agent's authored lines EXACTLY ONCE. Two double-count paths, both
 *      latent (no dossier in the frozen golden corpus exercises either, so
 *      revision 72's numbers are unaffected and the oracle needs no amendment):
 *      (a) A sub-agent can be written down TWICE — as `isSidechain: true`
 *      entries inside the parent `.jsonl`, whose lines the core's
 *      `TOOL_USE_HANDLERS` pass ALREADY books, and as its own
 *      `subagents/agent-*.jsonl` sidecar, which the fold also reads. The fold
 *      now skips any `tool_use.id` the parent counted
 *      (`parentCountedDiffToolUseIds`), the same identity `claude-parser.ts`
 *      already dedups `subagent.toolUses` on.
 *      (b) The sidecar lane skipped the parent lane's FEA-3453 `uuid` filter, so
 *      a resume/compaction-REPLAYED sidecar line contributed its edit twice. The
 *      filter is now shared (`replayed-entry.ts`) and applied per sidecar file
 *      before any accumulation, so a replayed line reaches neither the folded
 *      token entries, nor the delegation kickoffs, nor the diffStats fold.
 *      PR #4715 review (codex + wongk) found that dedup half-applied — the same
 *      revision-73 bump carries the other half, which had not shipped:
 *      (c) COST followed LOC. Suppressing (a)'s duplicate stopped the LINES
 *      being counted twice while `mergeFoldedUsage` still folded the SAME turn's
 *      usage a second time, because the FEA-1459 dedup key is enforced within a
 *      transcript and the shell folds two of them into one session. The core now
 *      publishes the keys it billed (`foldedUsageDedupKeySink`) and each sidecar
 *      is folded through them (`takeUnfoldedUsage`), so one API round-trip is
 *      billed once. The sub-agent's OWN row still carries its full usage.
 *      (d) The (a) suppression skipped the tool use's STATE as well as its
 *      count, so a duplicated `Write` left the overwrite baseline unset and the
 *      next `Write` to that path scored as a fresh all-added file. The
 *      suppressed record now advances the baseline
 *      (`applyDiffStatsToolUseState`) without contributing lines or a file.
 *      (e) The parent's counted-id seed keyed on the TOOL NAME alone, so a
 *      MALFORMED inline record — which the parent's total handlers coerce into a
 *      fabricated or empty delta — claimed the id and deleted the sidecar's
 *      well-formed copy of the same tool use. The seed now gates on the payload
 *      schema, matching the rule the sidecar passes already followed.
 *      (f) (b)'s uuid filter covered only the first of the TWO passes the parser
 *      makes over each sidecar; `scanSubagentTranscriptStream` had none, and its
 *      caller's dedup is keyed on `tool_use.id`, which idless records lack. A
 *      replayed idless tool use was therefore merged twice into
 *      `subagent.toolUses` and rode on into `session.skills` and the per-subagent
 *      tool events. The filter now lives in the scanner itself, covering the
 *      live-hook entry point too.
 *      Rebuild required because this is persisted parser output. A session whose
 *      sub-agents appear in exactly one representation and whose sidecars carry
 *      no replayed line — every dossier in the corpus, and the dominant live
 *      shape — re-derives byte-identically to revision-72 output; only a session
 *      that actually carried a duplicate loses the lines, tokens and tool
 *      records it never authored, and only one whose inline copy was corrupt
 *      GAINS back the measurement that copy was suppressing.
 *
 *  74. ISS-5764 + ISS-5763 — PR and branch references named in PROSE.
 *      `EXTRACTOR_VERSION` 23 → 24 adds a `prose_mention` pass to
 *      `artifact-ref-extractor.ts`. Every prior PR/branch recognizer in that
 *      file is anchored to a `gh`/`git` COMMAND, so a session that merely wrote
 *      "PR #4710", or laid its output out in a markdown table with a `PR`
 *      column, linked nothing — while the sibling ClosedLoop-slug recognizer
 *      has read prose since FEA-1684 (`slug_match_in_prose`), which is why the
 *      same session shows dozens of linked artifacts and zero PRs.
 *      The pass also closes the sub-agent gap: it reads the parent's messages,
 *      non-shell tool INPUT across the parent AND every sidecar sub-agent (via
 *      `collectSessionToolUses`, deduped by `tool_use.id` so an in-line
 *      sidechain tool and its sidecar copy count once), and delegation-tool
 *      OUTPUT — the only path by which a sub-agent's authored report reaches
 *      the parent, since a sidecar carries tool uses but no messages.
 *      Rebuild required: this is persisted parser output. It is purely
 *      ADDITIVE — every ref it mints is `relation: "referenced"` at the two
 *      weakest `CONFIDENCE_RANK` tiers, so no pre-existing link changes
 *      relation, method, confidence, or observed instant, and a session whose
 *      prose names no PR or branch re-derives byte-identically.
 *      `EXTRACTOR_VERSION` alone would not converge the corpus: it drives the
 *      file-enumerating `artifact-link-backfill.ts`, which reaches only the
 *      file-per-session harnesses. This bump is the harness-generic path.
 *  75. ISS-5497 — `recomputeSessionLastActivityAt` canonicalizes each
 *      `events.created_at` PER ROW before folding, so the fold compares
 *      fixed-width text (where byte order is time order) and the winner lands in
 *      canonical UTC form. It replaces a byte-wise `MAX()` over raw transcript
 *      text, which returned the EARLIER instant on a mixed-precision or
 *      offset-form column. A row whose stored text carries no explicit zone, or
 *      an offset spelling SQLite cannot parse, is left as-is and still competes.
 *      Rebuild required for the same reason revision 30 (FEA-3591) was minted
 *      for this same function: the corrected value is DERIVED at import, so an
 *      already-imported session keeps the wrong `last_activity_at` until it is
 *      re-derived. This rebuild is NOT what gets the corpus there in time, and
 *      must not be relied on as if it were (review): it runs from POST-BOOT
 *      maintenance, AFTER `openSqliteAgentDatabase` has already run the
 *      irreversible retention sweep on the old value, and a missing-source
 *      session is stamped 75 by the rollup bridge without the recompute running
 *      at all. The source-independent pre-sweep heal
 *      `healSessionLastActivityAtFloor` was widened on this ticket to discover
 *      exactly this disagreement, so a session's cursor is corrected from its
 *      STORED events before anything purges on it, and a failed heal chunk
 *      blocks both sweeps for that boot. The FEA-3743 format heal is not that
 *      path: it re-spells the stored value without changing which event it came
 *      from.
 *      Byte-identical to revision-74 output only when the session's `started_at`
 *      AND its winning event are BOTH already canonical — the whole local corpus
 *      after a successful format-heal boot, and every layer2 golden. Where they
 *      are not, the re-derived value is the same INSTANT re-spelled, except in
 *      the mixed-form case this ticket exists to fix, where it deliberately
 *      moves to the genuinely-latest event.
 *  76. ISS-6060 — rebuilds bounded Branch/PR monitored-session evidence; cloud projection is additive and capability-gated.
 *  77. Claude parser rewrite — the parser emits four persisted values it did
 *      not before, so already-imported Claude sessions hold a stale derivation
 *      until re-parsed. (a) An assistant-text `<command-name>` marker is scanned
 *      again, restoring `slashCommands` rows and the definition snapshots keyed
 *      to them, which a port dropped. (b) An inline-sidechain `Skill` call is
 *      counted once instead of twice in `skills`. (c) `usageExtras`
 *      `inference_geos` / `service_tiers` / `speeds` no longer record an empty
 *      string. (d) A sidechain record carrying no id source now yields an
 *      `unattributed-subagent` provenance row, so a turn stamped with that
 *      sentinel resolves to a listed subagent. Also re-derives
 *      `compactions[].timestamp` for a numeric-epoch stamp and drops a
 *      non-finite `turnDurations[].durationMs`.
 *
 *      Further values this revision re-derives, added after a second review
 *      pass found the list above incomplete: (e) the unattributed sentinel is
 *      excluded from spawn PAIRING, changing which subagent a delegation claims
 *      and therefore `agent_id` and `provider_tool_use_id` on invocation rows;
 *      (f) an agent file's top-level `tool_use` / `tool_result` records are
 *      collected again, adding `events` rows and `subagents[].toolUses` — with
 *      the tool's own output, which reaches `events.data.tool_response`; (g) a
 *      transcript that previously ABORTED its parse — a bare `null` line, a
 *      non-representable numeric timestamp — now imports, so `parse_quality`,
 *      `sessions.metadata` and every derived row for that session appear where
 *      there were none.
 *
 *      Deliberately NOT in this revision: the blank-definition-snapshot fix.
 *      Correcting the parser alone cannot converge sessions imported before it
 *      (see ISS-6574), so it ships with its heal rather than half-landing here.
 *
 *      DELEGATED-AGENT COUNTS DO MOVE, and an earlier draft of this entry said
 *      they do not. That claim held only for `agent_component_invocations`,
 *      which excludes the sentinel. The write lane does NOT:
 *      `mintParserSubagentAgentIds` / `write-core` insert an `agents` row for
 *      the sentinel, and `agentCount` reads that on desktop and in the cloud
 *      projection. Item (d) widened the population that mints it, since a
 *      sidechain turn that only SPOKE now qualifies where one carrying a
 *      `tool_use` was previously required. Correcting the write lane is
 *      deliberately NOT in this revision — it is filed as follow-up work, and
 *      the count moving is the disclosed consequence of shipping (d) first.
 *
 *      KNOWN LIMITATION, accepted deliberately (Chris Chenault, 2026-08-14,
 *      raised in review on PR #5061), and restated here because the first
 *      version of this paragraph got its mechanism wrong. A session whose
 *      re-parse cannot run is stamped at this revision anyway by
 *      `rebuildAgentComponentInvocationsFromStoredRows`, which rebuilds
 *      invocation and rollup rows from durable local rows, and is then excluded
 *      from later repair by the `data_revision != DATA_REVISION` cursor.
 *
 *      Two corrections to how that was first described. The affected population
 *      is NOT only MISSING-SOURCE sessions: `data-revision-rebuild.ts` routes
 *      `parserOutputFallbackIds` — sessions whose re-parse threw — through the
 *      same repairable set and the same bridge, and the FEA-3597 note there
 *      calls that class the largest one. And the values are NOT all in
 *      `sessions.metadata`: that blob carries `slashCommands`, `usageExtras`,
 *      `compactions` and `turnDurations`, but the subagent roster is `agents`
 *      rows and definition snapshots are
 *      `agent_component_invocations.definition_content` — both of which the
 *      bridge DOES touch. So the bridge is not uniformly powerless here; it is
 *      powerless for the transcript-derived blob and partial for the rest.
 *
 *      The trade was chosen against the alternatives: withholding the stamp
 *      re-selects those sessions on every boot for a repair that cannot fully
 *      succeed, and recording HOW a session was sealed — which would make the
 *      staleness detectable and targetable — is a schema change out of scope
 *      here. Do not "fix" this by withholding the stamp without revisiting that
 *      trade; it was chosen, not overlooked. It was, however, chosen against a
 *      description that was partly wrong, so revisiting it is legitimate.
 *  78. ISS-5105 — a CONTESTED delegation stops attributing its invocation to one
 *      of the children contesting it. Two refusals to guess, both on input that
 *      crosses the parser/sidecar trust boundary:
 *      (a) `matchSpawnedSubagent` applies the non-unique-claim exclusion to
 *      tier 0, not only to the fuzzy tiers. Tier 0 counted claimants by RAW
 *      provider id, so a MIXED-ALIAS contest — one child claiming a tool use's
 *      transcript `id`, its rival that same tool use's `providerToolUseId` —
 *      read there as one unopposed claimant and won, while
 *      `buildSubagentDedupIndex` (which canonicalizes both through
 *      `delegationClaimKey`) had already declared the pair unresolved and kept
 *      the `-sub-<toolUseId>` fallback `agents` row. The two consumers of ONE
 *      delegation therefore disagreed: the spawn event sat on the fallback row
 *      while `agent_component_invocations.agent_id` pointed at a contested
 *      child.
 *      (b) `indexDelegationToolUses` is collision-aware. An id that is tool A's
 *      `providerToolUseId` and tool B's transcript `id` resolved to whichever
 *      tool was indexed LAST, so attribution moved with sidecar read order; such
 *      a key is now dropped and the claim left unresolvable.
 *      Rebuild required because this is persisted attribution, not a read-time
 *      derivation: a session sealed at 77 keeps its contested `agent_id` until
 *      it re-derives. Sessions with no contested delegation — every session in
 *      the golden corpus, and every session whose children claim distinct
 *      delegations — re-derive to an identical invocation set.
 */
import { TERMINAL_STATUS_SET } from "../../database/db-constants.js";
export const COMPONENT_INVOCATION_STORED_REBUILD_REVISION = 39 as const;
export const DATA_REVISION = 78 as const;

/**
 * ISS-4572: the sentinel `data_revision` stamped on a session row by the ISOLATED
 * import path's FK-parent gate group BEFORE its later derived-row groups commit.
 * The real {@link DATA_REVISION} is stamped only by the final seal group, once
 * every group has committed without a per-session write-queue eviction.
 *
 * Why a sentinel is needed: the isolated import commits each record group in its
 * OWN write-queue transaction, and a genuinely-wedged group can be evicted by the
 * per-session import timeout (`cancelInFlightWrite`). If the gate had stamped the
 * real revision up front, an interrupted import would leave the session row at the
 * CURRENT revision with its events / token_usage / artifact-link groups missing —
 * and `data-revision-rebuild` (which re-derives only rows whose `data_revision`
 * differs from the current value) would never re-heal it, so it would render as a
 * fully-imported session with zero events until the next boot's re-import.
 * Stamping the sentinel first and sealing last means an interrupted import leaves
 * the row at `-1`, so the very next rebuild pass re-derives it.
 *
 * `-1` is chosen because every real revision the app has ever stamped is `>= 1`
 * (the column DEFAULT is 1 and {@link DATA_REVISION} only increases), so it can
 * never collide with a legitimately-stamped value and always satisfies the
 * rebuild's `data_revision != DATA_REVISION` predicate.
 */
export const DATA_REVISION_IMPORT_PENDING = -1 as const;

/**
 * ISS-5260: the `data_revision` a MAINTENANCE PASS stamps on a session whose
 * derived rows are known stale for a reason the revision counter cannot express
 * — the evidence a derivation depends on changed AFTER the session was sealed at
 * the current revision, so a one-shot bump can never select it again.
 *
 * The concrete case is skill resolution ordering. The slash-invocation re-point
 * gates on a RESOLVED skill inventory row read at materialization time. A
 * session imported before the definition collector promotes `(skill, X)` to
 * resolved keeps its `(command, /X)` attribution and is sealed at the CURRENT
 * revision, after which nothing selects it. Migration 0045 handled the same
 * dependency by resetting `data_revision` on the affected sessions rather than
 * leaning on the bump, and this is that mechanism made repeatable — see
 * `database/skill-shadow-inventory-maintenance.ts`.
 *
 * `0` is chosen for the same reason `-1` was: the column DEFAULT is 1 and
 * {@link DATA_REVISION} only increases, so it can never collide with a
 * legitimately-stamped value and always satisfies the rebuild's
 * `data_revision != DATA_REVISION` predicate. It is deliberately DISTINCT from
 * {@link DATA_REVISION_IMPORT_PENDING} so a row parked for re-derivation is not
 * mistaken in diagnostics for an import that was interrupted mid-flight.
 */
export const DATA_REVISION_MAINTENANCE_STALE = 0 as const;

/**
 * Should the stale-session rebuild fallback SKIP this session, and with what
 * result? Returns `null` when the rebuild should proceed.
 *
 * The boot-time stale list is advisory: it is a snapshot taken before the write
 * queue drains. Two things can change under it, and both are re-checked inside
 * the writer transaction rather than trusted from the snapshot.
 *
 *  - The session went non-terminal (active, running). It heals through ordinary
 *    import instead, so report it as an active race.
 *  - wongk (#4255): an ordinary watcher import finished AFTER the snapshot and
 *    sealed the session at the CURRENT revision — it is terminal and already
 *    fresh. Rebuilding anyway would delete that fully-derived invocation set,
 *    reconstruct it from stored rows (which cannot emit Hook candidates), and
 *    re-stamp the same revision, so nothing would ever select it again. A
 *    session already at the current revision is a no-op, not a rebuild.
 */
export function staleRebuildSkip(
  session: { status: string; dataRevision: number } | null,
  currentRevision: number
): { rebuilt: false; activeRace: boolean } | null {
  if (!session) {
    return { rebuilt: false, activeRace: false };
  }
  if (!TERMINAL_STATUS_SET.has(session.status)) {
    return { rebuilt: false, activeRace: true };
  }
  if (session.dataRevision === currentRevision) {
    return { rebuilt: false, activeRace: false };
  }
  return null;
}
