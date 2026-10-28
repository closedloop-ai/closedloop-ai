/**
 * @file codex-otel-trace-normalizer.ts
 * @description ISS-10719 — turns a received Codex OTLP TRACES export into the
 * {@link CodexOtelBatch} the persist lane already speaks.
 *
 * Codex exports were received, logged, and thrown away: the receiver wiring's
 * own comment said `db.codexOtel.persistBatch` was "a separate, still-unwired
 * lane". The writer, the `codex_trace_span` table and its `(trace_id, span_id)`
 * key all existed; what was missing was the shape between them, because the
 * receiver hands over a decoded OTLP payload and the writer consumes a
 * validated batch.
 *
 * ── Why this lane matters more here than on Claude ─────────────────────────
 * No Codex dossier records a `resultTimestamp` at all, so every Codex tool call
 * is a POINT EVENT and every bar drawn for one is an inferred upper bound, not
 * a latency. A span carries a real start and end, so this is the only route to a
 * MEASURED extent on Codex.
 *
 * ── What it refuses ────────────────────────────────────────────────────────
 * A span with no resolvable session, no usable instants, or a negative duration
 * is not persisted, because the table's rows are joined to `sessions.id` and a
 * row whose extent is impossible would render as a confident measurement. Each
 * refusal is COUNTED (`unusable`) rather than logged and dropped, so the
 * completeness counter ISS-10717 added covers this lane too.
 */

import {
  asOtlpRecordArray,
  decodeOtlpAttributes,
  decodeOtlpBytesToHex,
  groupOtlpSpansByResource,
} from "../otlp/decode-utilities.js";
import {
  identifiesCodex,
  otlpIdentityValues,
} from "../otlp/harness-identity.js";
import { isoFromUnixNano } from "./claude-code-otel-attributes.js";
import {
  CODEX_OTEL_MAX_BATCH_SPANS,
  type CodexOtelBatch,
  CodexOtelSpanStatus,
  parseCodexOtelBatch,
} from "./codex-otel-contract.js";

export type CodexOtelTraceNormalizationResult = {
  batch: CodexOtelBatch;
  /** Claimed spans that could not be turned into a row. */
  unusable: number;
};

/**
 * The attribute keys Codex can carry a session identity on, most specific
 * first. An ordered list rather than one key because the identity is the join to
 * `sessions.id` and a span that carries it under a name this list does not know
 * is refused, not guessed at.
 */
const SESSION_ID_ATTRIBUTE_KEYS = [
  "codex.session_id",
  "codex.conversation_id",
  "session.id",
  "session_id",
  "conversation.id",
  "conversation_id",
] as const;

/** The attribute keys a tool name can arrive under. */
const TOOL_NAME_ATTRIBUTE_KEYS = [
  "codex.tool_name",
  "tool.name",
  "tool_name",
] as const;

/**
 * `opentelemetry.proto.trace.v1.Status.StatusCode`, as the receiver's
 * `toObject` decode spells it — the enum name when the descriptor resolves it,
 * the ordinal otherwise. Both are accepted because which one arrives is a
 * property of the decode, not of the producer.
 */
const OTLP_STATUS_CODE = {
  Unset: new Set<unknown>([0, "STATUS_CODE_UNSET"]),
  Ok: new Set<unknown>([1, "STATUS_CODE_OK"]),
  Error: new Set<unknown>([2, "STATUS_CODE_ERROR"]),
};

export function normalizeCodexOtelTraceExport(payload: {
  decodedPayload: Record<string, unknown>;
}): CodexOtelTraceNormalizationResult {
  const spans: unknown[] = [];
  let unusable = 0;
  for (const group of groupOtlpSpansByResource(
    asOtlpRecordArray(payload.decodedPayload.resourceSpans)
  )) {
    // Re-decided PER RESOURCE CONTAINER, not once for the export: one OTLP
    // request may carry several producers' containers, and a non-Codex one must
    // not be persisted as Codex's.
    if (
      !identifiesCodex(
        otlpIdentityValues({ resourceAttributes: [group.resourceAttributes] })
      )
    ) {
      continue;
    }
    for (const span of group.leaves) {
      if (spans.length >= CODEX_OTEL_MAX_BATCH_SPANS) {
        // The batch cap is the writer's contract, not a suggestion; a span past
        // it is a real loss and is counted as one.
        unusable += 1;
        continue;
      }
      const row = codexSpanRowFrom(span, group.resourceAttributes);
      const validated = row === null ? null : validateSpan(row);
      if (validated) {
        spans.push(validated);
        continue;
      }
      unusable += 1;
    }
  }
  if (spans.length === 0) {
    return { batch: parseCodexOtelBatch({}), unusable };
  }
  return { batch: parseCodexOtelBatch({ spans }), unusable };
}

/**
 * Validate ONE span through the SAME `.strict()` schema the writer consumes.
 *
 * Per span rather than per batch, because `codexOtelBatchSchema` fails the whole
 * array on its first bad element: a single span tripping a constraint this
 * normalizer does not pre-check — too many attributes, an over-long key, a
 * status message past its cap — would otherwise discard every VALID span that
 * arrived with it, and the loss would be invisible except as a count.
 *
 * Returns the parsed span, or `null` for a refusal the caller counts.
 */
function validateSpan(span: unknown): unknown | null {
  try {
    const parsed = parseCodexOtelBatch({ spans: [span] });
    return parsed.spans[0] ?? null;
  } catch {
    return null;
  }
}

function firstStringAttribute(
  sources: Record<string, unknown>[],
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    for (const source of sources) {
      const value = source[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return undefined;
}

function statusFrom(span: Record<string, unknown>): CodexOtelSpanStatus {
  const code = (span.status as Record<string, unknown> | undefined)?.code;
  if (OTLP_STATUS_CODE.Error.has(code)) {
    return CodexOtelSpanStatus.Error;
  }
  if (OTLP_STATUS_CODE.Ok.has(code)) {
    return CodexOtelSpanStatus.Ok;
  }
  return CodexOtelSpanStatus.Unset;
}

/**
 * One span as the writer's schema wants it, or `null` when it cannot be made
 * into a row that means anything.
 *
 * A missing session, an unreadable instant, and a negative duration are all
 * refusals rather than defaults: the row would otherwise carry an invented join
 * key or an impossible extent, and this lane exists precisely so a Codex bar can
 * claim to be measured.
 */
function codexSpanRowFrom(
  span: Record<string, unknown>,
  resourceAttributes: Record<string, unknown>
): Record<string, unknown> | null {
  const traceId = decodeOtlpBytesToHex(span.traceId, { bytes: "buffer" });
  const spanId = decodeOtlpBytesToHex(span.spanId, { bytes: "buffer" });
  const name = typeof span.name === "string" ? span.name.trim() : "";
  if (!(traceId && spanId && name)) {
    return null;
  }
  const attributes = decodeOtlpAttributes(asOtlpRecordArray(span.attributes));
  const sessionId = firstStringAttribute(
    [attributes, resourceAttributes],
    SESSION_ID_ATTRIBUTE_KEYS
  );
  if (!sessionId) {
    return null;
  }
  const startTime = isoFromUnixNano(span.startTimeUnixNano);
  const endTime = isoFromUnixNano(span.endTimeUnixNano);
  if (!(startTime && endTime)) {
    return null;
  }
  const durationMs = Date.parse(endTime) - Date.parse(startTime);
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    return null;
  }
  const parentSpanId = decodeOtlpBytesToHex(span.parentSpanId, {
    bytes: "buffer",
  });
  const toolName = firstStringAttribute([attributes], TOOL_NAME_ATTRIBUTE_KEYS);
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    sessionId,
    name,
    startTime,
    endTime,
    durationMs,
    status: statusFrom(span),
    ...(toolName ? { toolName } : {}),
    attributes,
    resourceAttributes,
  };
}
