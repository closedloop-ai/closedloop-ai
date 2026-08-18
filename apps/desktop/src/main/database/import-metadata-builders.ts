/**
 * @file import-metadata-builders.ts
 * @description Pure, leaf JSON/metadata builders used by write-core.ts's historical
 * import phases (and the live-hook path). Each function is a transaction-independent,
 * DB-free serializer: the session import-metadata blob (`buildImportMetadata` and its
 * `usageExtras` shaper), the event/tool `data` column serializers
 * (`importEventData` / `importToolEventData` and the size-cap helper), and the
 * subagent id/name/metadata helpers. This module is a pure leaf — it imports only
 * external leaf modules (collector types, db-constants, db-helpers) and NOTHING from
 * `./write-core.js`, so write-core.ts can import these builders without an import cycle.
 */
import type {
  Harness,
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolUse,
} from "../collectors/types.js";
import { MAX_EVENT_DATA_BYTES } from "./db-constants.js";
import { strOf } from "./db-helpers.js";

// FEA-3527: drop the non-additive `reasoning_output_tokens` subdivision from the
// serialized `usageExtras` blob, preserving the rest of the shape (including the
// FEA-3496 `cache_creation` subdivision, and the pre-FEA-3527 default when
// absent) so the import-metadata blob is byte-identical to main for every
// session. The reasoning field remains on the in-memory
// `NormalizedSession.usageExtras` for parse-layer/analytics use.
//
// PRD-538: `web_search_requests` is ADDITIVELY persisted here (it IS a
// per-request billed line item the cost rollup reads back from this blob via
// `json_extract($.usageExtras.web_search_requests)`), but ONLY when > 0. Omitting
// the zero case keeps the blob byte-identical to pre-PRD-538 for every session
// that used no web search (all golden dossiers) — the frozen golden-layer2
// metadata sha256s don't drift, and a re-import of such a session doesn't flip
// `sessionDataChanged`. `json_extract` returns NULL for the omitted case, which
// the rollup coalesces to 0 web-search cost — identical to reading a persisted 0.
//
// ISS-5368 SETTLED that: an absent `web_search_requests` reads as ZERO, not
// unknown, so the omission above is the intended contract rather than a
// hash-stability workaround awaiting a nullable rewrite. Do not widen it to an
// "unknown" representation — that would drift the frozen golden metadata
// sha256s for a distinction the cost rollup deliberately does not make.
function shapePersistedUsageExtras(
  usageExtras: NormalizedSession["usageExtras"] | undefined
): Omit<
  NormalizedSession["usageExtras"],
  "reasoning_output_tokens" | "web_search_requests"
> & { web_search_requests?: number } {
  if (!usageExtras) {
    return {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
    };
  }
  const {
    reasoning_output_tokens: _reasoning,
    web_search_requests: webSearchRequests,
    ...rest
  } = usageExtras;
  return {
    ...rest,
    ...(webSearchRequests > 0
      ? { web_search_requests: webSearchRequests }
      : {}),
  };
}

export function buildImportMetadata(
  session: NormalizedSession,
  harness: Harness,
  internalMetadata: Readonly<Record<string, unknown>> = {}
): string {
  return JSON.stringify({
    version: session.version ?? null,
    slug: session.slug ?? null,
    gitBranch: session.gitBranch ?? null,
    userMessages: session.userMessages ?? 0,
    assistantMessages: session.assistantMessages ?? 0,
    entrypoint: session.entrypoint ?? harness,
    permissionMode: session.permissionMode ?? null,
    thinkingBlockCount: session.thinkingBlockCount ?? 0,
    teams: session.teams ?? [],
    plans: session.plans ?? [],
    // FEA-3527: `reasoning_output_tokens` is a non-additive SUBDIVISION of the
    // canonical output total — a parse-layer/analytics signal that must NOT enter
    // this serialized metadata blob. It stays on `NormalizedSession.usageExtras`
    // for the parser/analytics, but is stripped here so the blob is byte-identical
    // to pre-FEA-3527 for every session (Codex or not): the frozen golden-layer2
    // metadata sha256s don't drift, and a re-import of a pre-FEA-3527 session
    // doesn't flip `sessionDataChanged` and needlessly rewrite the row — no
    // DATA_REVISION bump / rebuild required. (Persisting it — some Codex sessions
    // carry reasoning_output_tokens > 0 — would necessarily drift those blobs and
    // could only reconcile by re-blessing frozen snapshots, which is forbidden;
    // DB persistence is deferred as a follow-up.) FEA-3419: the FEA-3496
    // `cache_creation` blob is GONE — the TTL split now rides `tokenSeries`
    // records and the token_usage/token_events typed columns as the single
    // source of truth; stale blob keys in pre-rev-31 metadata are dead data.
    usageExtras: shapePersistedUsageExtras(session.usageExtras),
    compactions: session.compactions ?? [],
    messages: session.messages ?? [],
    tokenSeries: session.tokenSeries ?? [],
    diffStats: session.diffStats ?? null,
    slashCommands: session.slashCommands ?? [],
    artifacts: session.artifacts ?? { prs: [], issues: [], repo: null },
    // FEA-2771: persist the parse-quality signal (malformed-line drops,
    // truncated final line) into the metadata blob so it survives the session
    // row, cloud sync, and detail reads — otherwise the parser computes it but
    // it is dropped before any consumer can observe corruption.
    parseQuality: session.parseQuality ?? null,
    // FEA-3525: persist the Codex model context-window size so downstream
    // consumers can derive context-window utilization. Only emitted when the
    // parser reported it (Codex `token_count.info.model_context_window`); the
    // key is omitted otherwise so pre-FEA-3525 sessions and non-Codex sources
    // produce a byte-identical metadata blob (no golden-layer2 snapshot churn).
    ...(session.modelContextWindow == null
      ? {}
      : { modelContextWindow: session.modelContextWindow }),
    // FEA-3524: persist the captured Codex `token_count` rate_limits snapshot
    // into the metadata blob so it survives the session row and reaches cloud
    // sync (sync-source forwards the whole metadata object). Emitted ONLY when
    // the parser reported a well-formed block; the key is omitted otherwise so
    // non-Codex sessions, rate_limits-null Codex sessions, and every pre-FEA-3524
    // payload produce a byte-identical metadata blob (no golden-layer2 snapshot
    // churn, so no DATA_REVISION bump / rebuild is required).
    ...(session.codexRateLimits == null
      ? {}
      : { codexRateLimits: session.codexRateLimits }),
    // FEA-3526: persist the captured Codex per-turn `last_token_usage` snapshots
    // into the metadata blob so they survive the session row and reach cloud
    // sync (sync-source forwards the whole metadata object). Emitted ONLY when
    // the parser captured a non-empty array; the key is omitted otherwise so
    // non-Codex sessions, token_count-free Codex sessions, and every pre-FEA-3526
    // payload produce a byte-identical metadata blob (no golden-layer2 snapshot
    // churn, so no DATA_REVISION bump / rebuild is required). Pure metadata — it
    // never feeds the token totals derived from `tokenSeries`.
    ...(session.codexLastTokenUsage == null ||
    session.codexLastTokenUsage.length === 0
      ? {}
      : { codexLastTokenUsage: session.codexLastTokenUsage }),
    ...internalMetadata,
  });
}

export function importEventData(input: unknown): string | null {
  if (input == null) {
    return null;
  }
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    return null;
  }
  if (text.length > MAX_EVENT_DATA_BYTES) {
    return JSON.stringify({ truncated: true, bytes: text.length });
  }
  return text;
}

export function importToolEventData(toolUse: NormalizedToolUse): string | null {
  // Bug 019f881c (thread PRRT_kwDOQ4gDpM6S0qJP): do NOT spread the full raw
  // `input` into `payload`/`base`. The heavy per-call input is carried once,
  // explicitly, in `detail.tool_input` below; spreading it flat here too stored
  // the same content twice and — worse — left the size-cap ineffective, since
  // dropping `detail` on an oversized row still left the full raw input in
  // `base`. `base` now holds ONLY the small derived analytics keys the usage
  // SQL reads (`$.skillName`/`$.mcpServer`/`$.mcpMethod`/`$.diffDelta`/`$.kind`/
  // `$.isError`), so `importToolPayloadWithinCap`'s cap actually bounds the row.
  const payload: Record<string, unknown> = {};
  const providerToolUseId = toolUse.providerToolUseId ?? toolUse.id;
  if (providerToolUseId) {
    payload.providerToolUseId = providerToolUseId;
  }
  if (toolUse.skillName && !payload.skillName) {
    payload.skillName = toolUse.skillName;
  }
  if (toolUse.mcpServer && !payload.mcpServer) {
    payload.mcpServer = toolUse.mcpServer;
  }
  if (toolUse.mcpMethod && !payload.mcpMethod) {
    payload.mcpMethod = toolUse.mcpMethod;
  }
  if (toolUse.diffDelta && !payload.diffDelta) {
    payload.diffDelta = toolUse.diffDelta;
  }
  // FEA-2642: persist the parser's builtin|harness|mcp classification so the
  // usage rollup (insertToolAndMcpUsage) can bucket harness/orchestration tools
  // separately from built-in IO tools. Previously dropped at import.
  if (toolUse.kind && !payload.kind) {
    payload.kind = toolUse.kind;
  }
  // Carry the tool-result error flag so the projection's status detail and the
  // usage/error SQL (`$.isError`) work for imported rows at parity with live.
  if (toolUse.isError) {
    payload.isError = true;
  }
  // Bug 019f881c: persist the per-call input/output under the SAME
  // `tool_input`/`tool_response` keys the live-hook path delivers, so the Session
  // Trace's expandable tool rows show captured detail for IMPORTED sessions too.
  // The projection's `toolCallDetailFields` (agent-session-detail-projection.ts)
  // reads `data.tool_input` / `data.tool_response`; before this,
  // `importToolEventData` only spread the input to TOP-LEVEL keys and dropped the
  // output entirely, so every transcript-collected tool row rendered "No detail
  // captured for this call". The small derived analytics keys set above on
  // `payload` are the ONLY top-level fields kept, for the analytics SQL that
  // reads `$.mcpServer` / `$.kind` / `$.skillName` / `$.isError`; the raw input
  // is no longer flat-spread there (thread PRRT_kwDOQ4gDpM6S0qJP).
  // Redaction stays upstream in the parser — no raw secret is introduced here
  // that the live-hook path wouldn't already carry. These two keys are the only
  // heavy fields (a large Write `content`, a big tool result), so they are added
  // via the size-aware helper below, which drops them (never the small analytics
  // keys) if the whole row would blow MAX_EVENT_DATA_BYTES.
  const detail: Record<string, unknown> = {};
  // Persist the raw per-call input under `tool_input` for ANY non-undefined
  // shape — object, string, OR array (thread PRRT_kwDOQ4gDpM6S0qJ_). The prior
  // `asRecord`-gated guard silently dropped string/array inputs (e.g. codex
  // `bash` calls whose `input` is a string), so the Session Trace rendered "No
  // detail captured" for exactly the shape this fix is meant to restore.
  if (toolUse.input !== undefined) {
    detail.tool_input = toolUse.input;
  }
  if (toolUse.output !== undefined) {
    detail.tool_response = toolUse.output;
  }
  // Both-empty (no analytics keys AND no detail) collapses to `null` inside
  // `importToolPayloadWithinCap`'s trailing `Object.keys(base).length > 0` guard,
  // so no redundant pre-check is needed here (thread PRRT_kwDOQ4gDpM6S7pq-).
  return importToolPayloadWithinCap(payload, detail);
}

/**
 * Serialize a tool event's `data` within `MAX_EVENT_DATA_BYTES`, preferring the
 * small analytics/metadata `base` keys over the heavy per-call `detail`
 * (`tool_input`/`tool_response`). If the combined row fits, keep the detail; if
 * not, drop the detail entirely so the row still carries its analytics keys
 * (never a total nuke to `{truncated}` that would blank the usage rollup). Bug
 * 019f881c: preserves both the FEA-3547 trace detail AND the FEA-2642 analytics
 * signals for oversized imported tool calls.
 */
function importToolPayloadWithinCap(
  base: Record<string, unknown>,
  detail: Record<string, unknown>
): string | null {
  if (Object.keys(detail).length > 0) {
    const combined = { ...base, ...detail };
    // Serialize once and measure directly (not the `{truncated}` sentinel, which
    // a tool input with a literal `truncated` key could otherwise spoof): keep
    // the full detail-bearing row only when it fits the cap.
    let combinedText: string | null = null;
    try {
      combinedText = JSON.stringify(combined);
    } catch {
      combinedText = null;
    }
    if (combinedText && combinedText.length <= MAX_EVENT_DATA_BYTES) {
      return combinedText;
    }
  }
  // No detail, unserializable, or oversized with detail attached: fall back to
  // just the analytics keys so the usage rollup never loses its
  // `$.mcpServer`/`$.kind`/`$.skillName` signals (importEventData still caps the
  // base itself, matching the pre-019f881c behavior for a huge bare input).
  return Object.keys(base).length > 0 ? importEventData(base) : null;
}

export function buildSubagentMetadata(
  subagent: NormalizedSubagent
): string | null {
  const metadata: Record<string, unknown> = {
    ...(subagent.metadata ?? {}),
  };
  if (subagent.nativeSubagentId) {
    metadata.nativeSubagentId = subagent.nativeSubagentId;
  }
  metadata.transcriptFileId = subagent.id;
  if (subagent.childSessionId) {
    metadata.childSessionId = subagent.childSessionId;
  }
  if (Object.keys(metadata).length === 0) {
    return null;
  }
  return importEventData(metadata);
}

export function sanitizeSubagentIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160);
}

/**
 * Mint the parser-lane `agents` row id for every parser subagent —
 * `<sessionId>-parser-sub-<sanitized>`, keyed by the RAW subagent id. This is
 * the write lane's one minting site (ISS-5099 review: the invocation lane
 * mints through the same `sanitizeSubagentIdSegment`, so the two cannot
 * drift). A subagent whose id sanitizes to empty mints no row.
 */
export function mintParserSubagentAgentIds(
  session: Pick<NormalizedSession, "sessionId" | "subagents">
): Map<string, string> {
  const bySubagentId = new Map<string, string>();
  for (const subagent of session.subagents ?? []) {
    const normalizedId = sanitizeSubagentIdSegment(subagent.id);
    if (normalizedId) {
      bySubagentId.set(
        subagent.id,
        `${session.sessionId}-parser-sub-${normalizedId}`
      );
    }
  }
  return bySubagentId;
}

export function subagentName(tu: NormalizedToolUse): string {
  const input = (tu.input ?? {}) as Record<string, unknown>;
  const description = strOf(input.description);
  const subagentType = strOf(input.subagent_type);
  const prompt = strOf(input.prompt);
  return (
    description ??
    subagentType ??
    (prompt ? prompt.split("\n")[0].slice(0, 60) : undefined) ??
    "Subagent"
  );
}

/**
 * ISS-4592: the persisted span for a subagent row whose duplicate
 * `-sub-<toolUseId>` twin was retired.
 *
 * That twin carried the delegation's real wall clock (the Agent/Task call
 * through its tool_result), while a folded sidecar's own record is frequently a
 * single instant — so dropping the twin without this would report every
 * subagent as taking 0s. The record's own span still wins whenever it is a real
 * interval; the spawning tool use is consulted only to repair a degenerate one.
 *
 * When the span is degenerate and no spawn tool use can repair it, the row is
 * marked unmeasured rather than floored to `now` or persisted as an equal pair.
 * The insights average (`apps/api/app/insights/service.ts`) skips a row whose
 * timestamp is absent but counts a `startedAt == endedAt` row as a real zero,
 * so writing a measurement we never made would drag the per-type average down
 * with delegations that were never timed. Unknown has to read as unknown.
 *
 * In the golden corpus this is 16 of 68 subagents: nested delegations whose
 * `Agent` call carries a timestamp but no `resultTimestamp`, so the start is
 * known and the end genuinely is not.
 */
export function subagentRowSpan(
  subagent: NormalizedSubagent,
  spawnToolUse: NormalizedToolUse | undefined,
  session: NormalizedSession,
  now: string
): { startedAt: string | null; endedAt: string } {
  const ownStart = subagent.startedAt ?? session.startedAt ?? null;
  const ownEnd = subagent.endedAt ?? session.endedAt ?? now;
  if (ownStart !== null && ownEnd > ownStart) {
    return { startedAt: ownStart, endedAt: ownEnd };
  }
  const spawnStart = spawnToolUse?.timestamp ?? null;
  const spawnEnd = spawnToolUse?.resultTimestamp ?? null;
  if (spawnStart !== null && spawnEnd !== null && spawnEnd > spawnStart) {
    return { startedAt: spawnStart, endedAt: spawnEnd };
  }
  // Unmeasurable: null the START, not the end. Nulling `endedAt` instead would
  // look more truthful and is actively worse — the desktop rollup joins on
  // `COALESCE(a.ended_at, a.updated_at)` (`local-insights.ts`), so a missing end
  // silently becomes the IMPORT time and the delegation reads as weeks long
  // (measured: a 16.9s bucket average became 1_817_472s). A null start is the
  // one shape BOTH duration consumers skip, and keeping `endedAt` populated
  // also stops a finished subagent from rendering as still running.
  return { startedAt: null, endedAt: ownEnd };
}
