/**
 * @file parse-codex.ts
 * @description Browser-safe OpenAI Codex CLI rollout parser core (extracted to
 * `@repo/lib/harness` for FEA-2717). Consumes an (async) iterable of rollout
 * JSONL lines — the desktop shell streams them from a file, the cloud renderer
 * splits the archived rollout — and produces the shared `NormalizedSession` so
 * Codex sessions render through the unchanged UI exactly like Claude sessions.
 *
 * Codex's rollout format has drifted across releases, so parsing is
 * intentionally tolerant: it accepts the modern RolloutLine envelope
 * (`{type:"session_meta"|"event_msg"|"response_item", payload, timestamp}`),
 * older bare records (the item itself on the line), and auto-detects a typed
 * `payload` under an unknown wrapper. Token usage in Codex `token_count`
 * events is CUMULATIVE per session, so the final value is the session total
 * (no delta math needed). Model attribution follows CodexBar's documented
 * rule: `turn_context.model` is authoritative.
 *
 * The desktop-only workflow-journal token merge, mtime read, session-id
 * derivation, and burst-threshold env reads stay in
 * `apps/desktop/.../codex-parser.ts`; the burst thresholds are injected here.
 *
 * Reference for the Codex format & token/model semantics: steipete/CodexBar
 * `docs/codex.md` (MIT) — see THIRD_PARTY_NOTICES.md.
 *
 * Ported from `scripts/agent-monitor-codex/codex-parser.js` (logic preserved).
 */

import type { NormalizedParseQuality } from "../parse-quality";
import { baseName, collectArtifacts, isMeaningfulCwd } from "../parser-utils";
import { addStorageTokenCounts, InvalidTokenCountError } from "../token-counts";
import { asRecord } from "../type-guards";
import type {
  NormalizedArtifacts,
  NormalizedMessage,
  NormalizedSession,
  NormalizedTokenCounts,
} from "../types";
import { createNormalizedSession, emptyUsageExtras } from "../types";
import {
  asStr,
  type Classified,
  CODEX_FALLBACK_MODEL,
  classify,
  createAccumulator,
  noteTimestamp,
  RESPONSE_ITEM_TYPES,
  type Rec,
  type RolloutAccumulator,
} from "./codex-accumulator";
import { dispatchEvent } from "./codex-event-handlers";
import { buildCodexLaunchAttribution } from "./codex-launch-attribution";
import { buildCodexParseQuality } from "./codex-parse-quality";
import { CODEX_PROTOCOL_SUPPORT } from "./codex-protocol-inventory";
import { dispatchResponseItem } from "./codex-response-item-handlers";
import {
  applyCodexSessionMeta,
  CODEX_AUTO_REVIEW_LABEL,
} from "./codex-session-meta";
import {
  type CodexTokenTotals,
  codexUsageSnapshotIdentity,
  readCodexTokenTotals,
} from "./codex-token-usage";

// ISS-7623: the parser core was split into siblings; `classify`/`Classified` and
// the two registry-derived inventories keep resolving from this module so every
// existing importer — the desktop collector, the cloud renderer, and the
// FEA-3715 protocol-inventory drift gate — needs no change.
// biome-ignore lint/performance/noBarrelFile: preserves this module's public export surface across the ISS-7623 split
export { type Classified, classify } from "./codex-accumulator";
export { CODEX_DECODED_EVENT_MSG_TYPES } from "./codex-event-handlers";
export { CODEX_DECODED_RESPONSE_ITEM_TYPES } from "./codex-response-item-handlers";

/**
 * FEA-1459 Fix 9: `codex-auto-review` is a reviewer label that leaks from
 * `turn_context.model`, not a real model. Token rows under this label are kept
 * (the spend is real), but it must never become the session-level `model`.
 */

/** Default burst-detection thresholds; the desktop shell overrides from env. */
const DEFAULT_BURST_RECORD_MIN = 20;
const DEFAULT_BURST_WINDOW_MS = 5000;

/** Options for the pure Codex rollout parse. */
export type ParseCodexRolloutOptions = {
  sessionId: string;
  /** Minimum records to trigger burst detection (desktop reads env; default 20). */
  burstRecordMin?: number;
  /** Burst-detection time window in ms (desktop reads env; default 5000). */
  burstWindowMs?: number;
  /** Leading cumulative usage snapshots already owned by a present parent fork. */
  replayedUsageIdentities?: ReadonlySet<string>;
  /** ISS-12552: see `RolloutAccumulator.attributionEvidence`; default on. */
  attributionEvidence?: boolean;
  /**
   * ISS-7625: the parse quality of a rollout that yielded NO session for want of
   * a usable timestamp. A sink, not a richer return type, because this parser is
   * a shared contract (the cloud renderer's `parse-transcript.ts`). Never fired
   * for a burst artifact, which is a healthy suppression and not a failure.
   */
  onUnreadableParse?: (quality: NormalizedParseQuality) => void;
};

/** Apply a turn_context record: turn_context.model is authoritative (CR-5). */
function applyTurnContext(acc: RolloutAccumulator, p: Rec): void {
  // CR-5: turn_context.model is authoritative per CodexBar docs.
  // FEA-1459 Fix 9: Skip codex-auto-review (reviewer label, not a model).
  const turnModel = asStr(p.model);
  if (turnModel && turnModel !== CODEX_AUTO_REVIEW_LABEL) {
    acc.model = turnModel;
  }
  if (turnModel) {
    acc.currentTurnModel = turnModel;
  }
  if (!acc.cwd) {
    const candidate = asStr(p.cwd);
    if (isMeaningfulCwd(candidate)) {
      acc.cwd = candidate;
    }
  }
}

/**
 * FEA-2641: drop injected-context user messages from the human record.
 *
 * Codex reuses the `user` role on response_items for context it injects
 * itself — the `# AGENTS.md instructions` blob and `<environment_context>` —
 * which over-counts human turns everywhere downstream (is_human
 * classification, the activity heatmap's Human series, userMessages). The
 * discriminator is structural, not textual: Codex emits an
 * `event_msg`/`user_message` record ONLY for prompts actually submitted
 * (typed or scripted), never for injected context. Each event text is
 * consumed against at most one response_item user message (count-per-text,
 * mirroring the claude-parser scheduledPrompts semantics) so repeated
 * identical prompts stay counted.
 *
 * Rollouts with NO user_message events at all (3 of 1,555 in the local
 * census — aborted/legacy files) keep the response_item-derived messages
 * unchanged, so old formats can never lose genuine turns. When events exist,
 * userMessageCount is normalized to the event count — the double increment
 * from handleMessageItem + handleUserMessageEvent previously over-counted
 * modern rollouts.
 */
function filterInjectedUserMessages(acc: RolloutAccumulator): void {
  // ISS-12552: Codex 0.163 writes `UserMessage` items instead of the events.
  const [submittedTexts, submittedCount] =
    acc.emUserCount > 0
      ? [acc.emUserTexts, acc.emUserCount]
      : [acc.itemUserTexts, acc.itemUserCount];
  if (submittedCount === 0) {
    return;
  }
  const injected = new Set<NormalizedMessage>();
  for (const ref of acc.humanMessageRefs) {
    const key = ref.raw.trim();
    const pending = submittedTexts.get(key);
    if (pending) {
      if (pending === 1) {
        submittedTexts.delete(key);
      } else {
        submittedTexts.set(key, pending - 1);
      }
    } else {
      injected.add(ref.msg);
    }
  }
  if (injected.size > 0) {
    acc.messages = acc.messages.filter((m) => !injected.has(m));
  }
  acc.userMessageCount = submittedCount;
}

/** Dispatch a single classified rollout line into the accumulator. */
function dispatchLine(
  acc: RolloutAccumulator,
  c: Classified,
  iso: string | null,
  explicitIso: string | null
): void {
  switch (c.kind) {
    case "session_meta":
      applyCodexSessionMeta(acc, c.p);
      break;
    case "turn_context":
      applyTurnContext(acc, c.p);
      break;
    case "response_item":
      dispatchResponseItem(acc, c.p, iso, explicitIso);
      break;
    case "event":
      dispatchEvent(acc, c.p, iso, explicitIso);
      break;
    case "auto":
      if (typeof c.p.type === "string" && RESPONSE_ITEM_TYPES.has(c.p.type)) {
        dispatchResponseItem(acc, c.p, iso, explicitIso);
      } else {
        dispatchEvent(acc, c.p, iso, explicitIso);
      }
      break;
    default:
      // "other" — no usable kind; ignored.
      break;
  }
}

/**
 * FEA-1459 Fix 4: a re-serialized rollout burst produces duplicate sessions
 * (39 sessions in 91s on 2026-05-22, every record stamped within ~350ms;
 * 32/223 codex sessions had <2s span with >50 events). These are resume/fork
 * artifacts, not real sessions. Threshold 20: real records require API
 * round-trips, so 20+ records can never fit in 5s; a re-audit with >=50 left 26
 * sub-second fragments (<=23 records) alive while the one genuine session in
 * the burst window (54 records over 945s) sails through either threshold.
 */
function isBurstSession(
  acc: RolloutAccumulator,
  burstRecordMin: number,
  burstWindowMs: number
): boolean {
  if (!(acc.firstTimestamp && acc.lastTimestamp)) {
    return false;
  }
  const span =
    new Date(acc.lastTimestamp).getTime() -
    new Date(acc.firstTimestamp).getTime();
  const recordCount =
    acc.messages.length +
    acc.toolUses.length +
    acc.tokenSeries.length +
    acc.turnDurations.length;
  return recordCount >= burstRecordMin && span < burstWindowMs;
}

/**
 * FEA-1459 (PR #1511 review): a RESUMED burst rollout replays the original
 * session's records in a tight leading burst, then appends real work. The
 * whole-file span check ({@link isBurstSession}) no longer fires (span > 5s),
 * but the replayed token_counts would re-import the original session's
 * cumulative totals — the first one as a single giant delta — double-counting
 * spend the original rollout file already owns. Detect a >=20-record burst
 * inside the first 5s and drop its token entries from `acc.tokenSeries`.
 * Since buildTokensByModel sums tokenSeries (FEA-2343), filtering the
 * replayed entries is sufficient — no baseline subtraction needed.
 */
function rebaseReplayedBurst(
  acc: RolloutAccumulator,
  burstRecordMin: number,
  burstWindowMs: number
): void {
  if (!acc.firstTimestamp) {
    return;
  }
  const startMs = new Date(acc.firstTimestamp).getTime();
  const inLeadingBurst = (ts: string | null | undefined): boolean =>
    typeof ts === "string" && new Date(ts).getTime() - startMs < burstWindowMs;
  const burstRecordCount =
    acc.messages.filter((m) => inLeadingBurst(m.timestamp)).length +
    acc.toolUses.filter((tu) => inLeadingBurst(tu.timestamp)).length +
    acc.tokenSeries.filter((e) => inLeadingBurst(e.timestamp)).length +
    acc.turnDurations.filter((td) => inLeadingBurst(td.timestamp)).length;
  if (burstRecordCount < burstRecordMin) {
    return;
  }
  // FEA-3681: return early only when NEITHER the rebased `tokenSeries` NOR the
  // parallel `tokenEventTimestamps` has a burst-window entry. A FULLY zero-delta
  // replayed burst bumps `assistantMessageCount` and records a
  // `tokenEventTimestamps` entry for every event but pushes NO `tokenSeries`
  // entry (delta zero → `iso && hasTokens` false at the count site; see the
  // FEA-3608 explanation on the decrement below). Gating on `tokenSeries` alone
  // let that case skip the decrement below, leaving `assistantMessages`/`turns`
  // inflated by the replayed round-trips even though the token totals were
  // rebased — the exact under-count FEA-3608 fixed for the partial-zero case.
  // Keep BOTH disjuncts: the `tokenSeries` term still guards the FEA-2343
  // deferred-flush entry pushed just above (timestamped, but with no matching
  // `tokenEventTimestamps` push), so neither disjunct fully subsumes the other.
  if (
    !(
      acc.tokenSeries.some((e) => inLeadingBurst(e.timestamp)) ||
      acc.tokenEventTimestamps.some((ts) => inLeadingBurst(ts))
    )
  ) {
    return;
  }
  let writeIdx = 0;
  for (const e of acc.tokenSeries) {
    if (!inLeadingBurst(e.timestamp)) {
      acc.tokenSeries[writeIdx++] = e;
    }
  }
  acc.tokenSeries.length = writeIdx;
  // FEA-3608: decrement assistantMessages by the number of burst `token_count`
  // EVENTS, not the number of removed `tokenSeries` entries. FEA-3439 used the
  // removed-entry count, which UNDER-counts whenever a replayed burst event had
  // a zero delta (cumulative unchanged) or no own timestamp: `assistantMessageCount++`
  // runs for EVERY extractable `token_count` event, but `tokenSeries.push` runs
  // only when `iso && hasTokens`, so such an event bumps the count with no
  // matching entry to remove. Counting the per-event timestamps recorded at the
  // count site restores the exact FEA-3125/FEA-3439 `turns` (userMessages +
  // assistantMessages) vs rebased-token alignment. Filter the parallel array by
  // the same `inLeadingBurst` predicate so it stays in sync with the surviving
  // round-trips.
  // FEA-3682: rebase `reasoningOutputTokens` in lockstep with the token-event
  // filtering below. It is a whole-file cumulative MAX, so without this the
  // replayed burst's parent reasoning survives while the output total is rebased
  // to a burst-relative delta — the surfaced `reasoning_output_tokens` could
  // then exceed the session's own output (breaking the FEA-3527 subset
  // invariant) and double-count the parent's reasoning across resumed sessions.
  // Re-derive it as (max surviving cumulative reasoning − max burst cumulative
  // reasoning), the reasoning analogue of the output delta rebase: the burst
  // supplies the baseline the surviving portion is measured against, just as the
  // first surviving output delta is computed against the last burst snapshot.
  // Reasoning is tracked as a cumulative MAX (mirroring the max at the capture
  // site above) rather than last-wins so an out-of-order or reset snapshot can't
  // deflate the baseline — for the monotonic cumulative snapshots a replay
  // produces, the max IS the last, and choosing the max keeps the rebased value
  // an underestimate-safe subset of output (a larger baseline can only shrink
  // it). `reasoningOutputSnapshots` is index-aligned with `tokenEventTimestamps`,
  // so both are filtered together.
  let tokenEventWriteIdx = 0;
  let burstTokenEventCount = 0;
  let burstReasoningBaseline = 0;
  let survivingReasoningMax = 0;
  for (let i = 0; i < acc.tokenEventTimestamps.length; i++) {
    const ts = acc.tokenEventTimestamps[i];
    const reasoning = acc.reasoningOutputSnapshots[i] ?? 0;
    if (inLeadingBurst(ts)) {
      burstTokenEventCount++;
      if (reasoning > burstReasoningBaseline) {
        burstReasoningBaseline = reasoning;
      }
    } else {
      if (reasoning > survivingReasoningMax) {
        survivingReasoningMax = reasoning;
      }
      acc.reasoningOutputSnapshots[tokenEventWriteIdx] = reasoning;
      acc.tokenEventTimestamps[tokenEventWriteIdx] = ts;
      tokenEventWriteIdx++;
    }
  }
  acc.tokenEventTimestamps.length = tokenEventWriteIdx;
  acc.reasoningOutputSnapshots.length = tokenEventWriteIdx;
  acc.assistantMessageCount -= burstTokenEventCount;
  acc.reasoningOutputTokens = Math.max(
    0,
    survivingReasoningMax - burstReasoningBaseline
  );
  // FEA-3526: the per-turn `last_token_usage` snapshots are pushed from the same
  // `token_count` events as `tokenSeries`, so a replayed leading burst re-imports
  // them too. Drop the burst snapshots by the SAME `inLeadingBurst` predicate to
  // keep the two arrays' event membership in sync — otherwise the metadata would
  // carry duplicate replayed snapshots the canonical (rebased) token totals no
  // longer count.
  let snapshotWriteIdx = 0;
  for (const s of acc.codexLastTokenUsage) {
    if (!inLeadingBurst(s.timestamp)) {
      acc.codexLastTokenUsage[snapshotWriteIdx++] = s;
    }
  }
  acc.codexLastTokenUsage.length = snapshotWriteIdx;
}

/**
 * Build model-keyed token totals by summing per-turn deltas from
 * `acc.tokenSeries`. The series is already rebased (burst/fork replay
 * entries filtered) and clamped (counter-reset deltas are 0), so the
 * sum is the correct session total. This matches the Claude parser's
 * delta-based approach (foldDedupMap) and eliminates the class of
 * cumulative-vs-delta divergence bugs (FEA-2343).
 */
function buildTokensByModel(
  acc: RolloutAccumulator
): Record<string, NormalizedTokenCounts> {
  // ISS-7959: fold into a null-prototype object so a model literally named
  // `__proto__` becomes an own property instead of hitting the
  // `Object.prototype.__proto__` setter and silently dropping its whole spend.
  const tokensByModel: Record<string, NormalizedTokenCounts> = Object.create(
    null
  ) as Record<string, NormalizedTokenCounts>;
  for (const entry of acc.tokenSeries) {
    // FEA-1459 Fix 9: codex-auto-review is a reviewer label, not a real
    // model. Remap its tokens to the session model or priceable fallback
    // so importSessionWithTx never backfills sessions.model from it.
    const key =
      entry.model === CODEX_AUTO_REVIEW_LABEL
        ? (acc.model ?? CODEX_FALLBACK_MODEL)
        : entry.model;
    const inferred =
      entry.model === CODEX_AUTO_REVIEW_LABEL && !acc.model
        ? true
        : entry.inferred;
    const existing = tokensByModel[key];
    tokensByModel[key] = {
      input: addStorageTokenCounts(
        existing?.input ?? 0,
        entry.input,
        "codex.fold_input"
      ),
      output: addStorageTokenCounts(
        existing?.output ?? 0,
        entry.output,
        "codex.fold_output"
      ),
      cacheRead: addStorageTokenCounts(
        existing?.cacheRead ?? 0,
        entry.cacheRead,
        "codex.fold_cache_read"
      ),
      cacheWrite: addStorageTokenCounts(
        existing?.cacheWrite ?? 0,
        entry.cacheWrite,
        "codex.fold_cache_write"
      ),
      ...(existing?.inferred || inferred ? { inferred: true } : {}),
    };
  }
  // Spread restores a normal prototype for downstream consumers (object spread
  // defines rather than assigns, so an own `__proto__` key survives the copy).
  return { ...tokensByModel };
}

function extractEventModelForIdentity(p: Rec, info: Rec): string | null {
  const turnCtx = asRecord(p.turn_context);
  const model =
    (turnCtx && asStr(turnCtx.model)) || asStr(info.model) || asStr(p.model);
  return model && model !== CODEX_AUTO_REVIEW_LABEL ? model : null;
}

/**
 * Parse a single Codex rollout (an async/sync iterable of JSONL lines) into the
 * normalized session object. Returns null when the rollout carries no usable
 * timestamp (mirrors the Claude parser's contract so importSession can treat
 * both identically).
 *
 * This is the single-rollout core. The desktop shell wraps it to stream a file,
 * merge companion workflow-journal tokens, and stamp `fileModifiedAt` — behavior
 * that is DB-import-specific and not part of the cloud renderer's per-file parse.
 */
export async function parseCodexRollout(
  lines: AsyncIterable<string> | Iterable<string>,
  options: ParseCodexRolloutOptions
): Promise<NormalizedSession | null> {
  const { sessionId } = options;
  const burstRecordMin = options.burstRecordMin ?? DEFAULT_BURST_RECORD_MIN;
  const burstWindowMs = options.burstWindowMs ?? DEFAULT_BURST_WINDOW_MS;

  const acc = createAccumulator({
    replayedUsageIdentities: options.replayedUsageIdentities,
    attributionEvidence: options.attributionEvidence,
  });

  // FEA-2907: track malformed-line drops so the session carries a parse-quality
  // signal at parity with the Claude parser (FEA-2771). A malformed FINAL line
  // is the benign shape of a truncated in-progress rollout; a malformed line
  // anywhere earlier silently loses that turn's token usage and events
  // (apiErrors stays empty), so it must be surfaced. Counting mirrors the
  // desktop `readJsonlLinesWithQuality` scan so the shared contract holds on
  // both surfaces.
  let totalLines = 0;
  let malformedLines = 0;
  let lastLineMalformed = false;
  // FEA-3713: count valid-JSON records the classifier cannot route to any
  // handler (`kind:"other"` — the `dispatchLine` default that silently drops the
  // record). A record the parser doesn't understand was previously ignored
  // without lowering any parse-quality signal; tracking it surfaces the loss.
  let unknownRecords = 0;

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    totalLines++;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      malformedLines++;
      lastLineMalformed = true;
      continue;
    }
    lastLineMalformed = false;
    const c = classify(rec);
    if (!c) {
      continue;
    }
    if (c.kind === "other") {
      unknownRecords++;
    }
    const explicitIso = noteTimestamp(acc, c.ts);
    const iso = explicitIso || acc.lastTs;
    dispatchLine(acc, c, iso, explicitIso);
  }

  // Snapshot once: the no-session report and the session both describe this scan.
  const scan = {
    totalLines,
    malformedLines,
    lastLineMalformed,
    unknownRecords,
  };

  if (!acc.firstTimestamp) {
    // ISS-7625: this `null` is where the counts used to die.
    options.onUnreadableParse?.(buildCodexParseQuality(acc, scan));
    return null;
  }

  if (isBurstSession(acc, burstRecordMin, burstWindowMs)) {
    return null;
  }

  // FEA-2343: flush any untimestamped leading token deltas that were never
  // folded into a timestamped entry during the parsing loop.
  if (acc.deferredTokenDelta) {
    const ts = acc.lastTs ?? acc.firstTimestamp;
    if (ts) {
      const d = acc.deferredTokenDelta;
      const eventModel = acc.model ?? CODEX_FALLBACK_MODEL;
      const eventInferred = !acc.model;
      acc.tokenSeries.push({
        timestamp: ts,
        model: eventModel,
        input: d.input,
        output: d.output,
        cacheRead: d.cacheRead,
        cacheWrite: d.cacheWrite,
        ...(eventInferred ? { inferred: true } : {}),
      });
    }
    acc.deferredTokenDelta = null;
  }

  rebaseReplayedBurst(acc, burstRecordMin, burstWindowMs);

  filterInjectedUserMessages(acc);

  const tokensByModel = buildTokensByModel(acc);

  // CR-13: collect artifact references from all tool uses
  const artifacts: NormalizedArtifacts = collectArtifacts(
    acc.toolUses,
    acc.cwd
  );

  const projectName = acc.cwd
    ? baseName(acc.cwd)
    : `Codex Session ${sessionId.slice(0, 8)}`;

  const codexLaunchAttribution = buildCodexLaunchAttribution(
    acc.launchAttribution
  );

  // Unset fields are filled by createNormalizedSession's defaults. The desktop
  // shell merges companion workflow-journal tokens and stamps the source mtime;
  // the cloud renderer has no local file, so the core leaves those alone.
  return createNormalizedSession({
    sessionId,
    name: projectName,
    cwd: acc.cwd,
    model: acc.model,
    version: acc.version,
    gitBranch: acc.gitBranch,
    startedAt: acc.firstTimestamp,
    endedAt: acc.lastTimestamp,
    userMessages: acc.userMessageCount,
    assistantMessages: acc.assistantMessageCount,
    tokensByModel,
    messageTimestamps: acc.messageTimestamps,
    toolUses: acc.toolUses,
    ...(acc.mcpCallEvidence.length > 0
      ? { mcpCallEvidence: acc.mcpCallEvidence }
      : {}),
    plans: acc.plans,
    compactions: acc.compactions, // FEA-3127
    apiErrors: acc.apiErrors,
    fileModifiedAt: null,
    turnDurations: acc.turnDurations,
    // FEA-2641: the Codex-stamped launch mode (session_meta.originator) is the
    // entrypoint, so headless runs (codex_exec, *-exec wrappers) are
    // distinguishable from keyboard sessions (codex-tui, codex_cli_rs,
    // codex_vscode) downstream. "codex" only for rollouts predating the field.
    entrypoint: acc.originator ?? "codex",
    thinkingBlockCount: acc.thinkingBlockCount,
    toolResultErrors: acc.toolResultErrors,
    messages: acc.messages, // CR-1
    tokenSeries: acc.tokenSeries, // CR-2
    // FEA-3526: authoritative per-turn `last_token_usage` snapshots (metadata;
    // omitted when the rollout emitted no token_count events).
    ...(acc.codexLastTokenUsage.length > 0
      ? { codexLastTokenUsage: acc.codexLastTokenUsage }
      : {}),
    diffStats: acc.diffStats, // CR-4
    // FEA-3527: surface the cumulative reasoning-output subdivision as metadata.
    // A SUBSET of the output total already counted in tokenSeries/tokensByModel —
    // never additive. Other usageExtras fields keep their empty defaults.
    usageExtras: {
      ...emptyUsageExtras(),
      reasoning_output_tokens: acc.reasoningOutputTokens,
    },
    artifacts, // CR-13
    // FEA-2907: parse-quality signal (malformed-line drops, truncated final line)
    // at parity with the Claude parser (FEA-2771).
    // FEA-3702: `malformedRateLimits` counts present-but-malformed `rate_limits`
    // blocks whose last-good snapshot was preserved. Stamped only when nonzero so
    // clean sessions omit it and round-trip unchanged (no golden snapshot churn).
    // FEA-3713 adds unknownRecords, emitted only when non-zero so clean rollouts
    // round-trip byte-identically (no golden-snapshot churn) — the Claude core
    // omits the field entirely.
    // FEA-3701: the MCP/tool-output correlation diagnostics are additive and are
    // OMITTED when zero, so a clean session round-trips byte-identical to its
    // frozen normalized.json (only genuinely orphaned/ambiguous records surface).
    parseQuality: buildCodexParseQuality(acc, scan),
    // FEA-3525: only set when Codex reported it, so rollouts without a
    // model_context_window omit the field and round-trip unchanged.
    ...(acc.modelContextWindow === null
      ? {}
      : { modelContextWindow: acc.modelContextWindow }),
    // FEA-3524: only stamp the field when a well-formed rate_limits block was
    // seen, so rate_limits-null sessions omit it and pre-existing payloads
    // round-trip unchanged.
    ...(acc.codexRateLimits ? { codexRateLimits: acc.codexRateLimits } : {}),
    // FEA-3708: only stamp the parent-rollout lineage pointer when the rollout
    // was forked/resumed (session_meta.forked_from_id present), so a root
    // session and every non-Codex payload omit it and round-trip unchanged.
    ...(acc.forkedFromId ? { codexForkedFromId: acc.forkedFromId } : {}),
    // ISS-7259: omitted entirely when session_meta stated no attribution, so a
    // rollout that carries none round-trips byte-identically.
    ...(codexLaunchAttribution
      ? { harnessLaunchAttribution: codexLaunchAttribution }
      : {}),
    // FEA-3715: record the reviewed Codex protocol pin the parser decoded this
    // rollout under, so every Codex session self-documents the supported
    // version/commit range. Static metadata — it never feeds token math, is
    // stripped before the Layer-1 golden deep-equal (the signed oracles
    // predate it), and is intentionally NOT persisted to the DB metadata blob
    // (it would drift every Codex session's snapshot for no per-session signal).
    codexProtocolSupport: CODEX_PROTOCOL_SUPPORT,
  });
}

/**
 * Collect the cumulative-usage snapshot identities from a Codex rollout's lines,
 * used by the desktop collector's fork/replay dedup (a resumed rollout replays
 * the parent's leading token_count snapshots). Pure over the lines; the desktop
 * shell wraps it with file streaming.
 */
export async function collectCodexUsageIdentities(
  lines: AsyncIterable<string> | Iterable<string>
): Promise<Set<string>> {
  const identities = new Set<string>();
  let model: string | null = null;
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const c = classify(rec);
    if (!c) {
      continue;
    }
    if (c.kind === "turn_context") {
      const turnModel = asStr(c.p.model);
      if (turnModel && turnModel !== CODEX_AUTO_REVIEW_LABEL) {
        model = turnModel;
      }
      continue;
    }
    if (c.kind !== "event" && c.kind !== "auto") {
      continue;
    }
    const eventType = asStr(c.p.type);
    if (eventType !== "token_count") {
      continue;
    }
    const info = asRecord(c.p.info) ?? asRecord(c.p.token_count_info) ?? c.p;
    const totals =
      asRecord(info.total_token_usage) ??
      asRecord(info.totalTokenUsage) ??
      asRecord(info.total);
    if (!totals) {
      continue;
    }
    const eventModel = extractEventModelForIdentity(c.p, info) ?? model;
    // Mirror `handleTokenCountEvent`'s invalid-counter tolerance: a parent
    // rollout carrying a fractional / negative / JS-unsafe cumulative counter
    // must not throw here and abort the whole fork/replay dedup (which would
    // blank a forked descendant's import). Drop this snapshot's identity and
    // keep collecting — a missing identity only weakens dedup for that one
    // snapshot, it does not corrupt the child parse.
    let snapshot: CodexTokenTotals;
    try {
      snapshot = readCodexTokenTotals(totals, "codex.identity");
    } catch (error) {
      if (error instanceof InvalidTokenCountError) {
        continue;
      }
      throw error;
    }
    identities.add(codexUsageSnapshotIdentity(eventModel, snapshot));
  }
  return identities;
}
