/**
 * How a tool event's raw `data` becomes the displayable per-call detail the
 * expanded-tool UI renders: the redaction markers, the cross-surface error
 * signal, the truncated input/output fields, the honest detail STATE, and the
 * call duration.
 *
 * Split out of `agent-session-detail-projection.ts` (ISS-5592 review, wongk
 * #5120), which sat above the 1,000-line hard ceiling in the root `AGENTS.md`
 * and grew again in that change — the rule is that a grandfathered file leaves
 * a substantive change SMALLER, so the concern its edit touched is the one that
 * moves. This is a whole responsibility, not a slice at a line count: every
 * symbol here reads a tool event's `data` and nothing here knows about turns,
 * timelines, agents, or sessions.
 *
 * Exactly two symbols are consumed by the projection; the rest are private to
 * this concern, which is what made the seam obvious.
 */
import type {
  SessionTimelineEvent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import {
  type ToolCallDetailState,
  TRACE_TOOL_INPUT_MAX_CHARS,
  TRACE_TOOL_OUTPUT_MAX_CHARS,
} from "@repo/api/src/types/agent-session-tool-call";
import {
  asRecord,
  clipText,
  commandDetail,
  jsonToDisplayText,
  numberValue,
  statusDetail,
  timestampMs,
} from "./agent-session-projection-utils";

/**
 * FEA-3696: the JSON keys a producer sets to signal that a call's input/output
 * was deliberately removed for policy (secret/PII redaction) BEFORE it reached
 * the read path. A truthy value means "detail existed but was redacted", which
 * must render as an honest `redacted` panel — not the same empty state as a call
 * whose detail simply wasn't hydrated. Kept permissive (both snake/camel) so a
 * future producer can stamp either without a contract change.
 */
const REDACTION_MARKER_KEYS = [
  "redacted",
  "isRedacted",
  "is_redacted",
] as const;

function isRedactedData(data: Record<string, unknown>): boolean {
  return REDACTION_MARKER_KEYS.some((key) => Boolean(data[key]));
}

/**
 * Whether a tool event represents a FAILED call. The transcript-projection path
 * (`transcript-turn-items.ts`) flags errors by tagging the eventType
 * `PostToolUseError`; the desktop IMPORT path stores every tool as `PostToolUse`
 * but persists the parsed error flag in `data.isError` (bug 019f881c) — and the
 * live-hook path may carry `data.tool_response.is_error`. Honor all three so the
 * red error dot / `err` row flag is consistent across surfaces.
 */
export function eventIndicatesToolError(
  event: SyncedAgentSessionEvent
): boolean {
  if (event.eventType.toLowerCase().includes("error")) {
    return true;
  }
  const data = asRecord(event.data);
  if (!data) {
    return false;
  }
  if (data.isError === true || data.is_error === true) {
    return true;
  }
  const toolResponse = asRecord(data.tool_response);
  return toolResponse?.is_error === true || toolResponse?.isError === true;
}

/**
 * FEA-3547: extract the expandable per-call fields (input/output/duration/
 * status) from a tool event's `data`. Returns only the keys that resolved to a
 * value so the spread stays additive. Command/output are truncated to their
 * shared caps with an explicit `*Truncated` flag; duration is derived from the
 * tool_use → tool_result timestamps when both are present.
 *
 * FEA-3696: also stamps a TRUTHFUL `toolDetailState` on every tool row so the
 * expanded-tool UI never shows an ambiguous "no detail" for a call whose detail
 * merely lives elsewhere:
 *   - no `data` at all (cloud DB-events path, which strips `data`)  → `unavailable`
 *   - `data` carries a redaction marker                             → `redacted`
 *   - `data` present but neither input nor output is displayable    → `malformed`
 *   - input/output displayable and clipped to the caps              → `truncated`
 *   - input/output displayable and whole                            → `available`
 */
export function toolCallDetailFields(
  event: SyncedAgentSessionEvent
): Partial<
  Pick<
    SessionTimelineEvent,
    | "toolInput"
    | "toolInputTruncated"
    | "toolOutput"
    | "toolOutputTruncated"
    | "toolDurationMs"
    | "toolStatus"
    | "toolDetailState"
  >
> {
  const data = asRecord(event.data);
  const fields: ReturnType<typeof toolCallDetailFields> = {};
  // No `data` blob at all: the cloud DB-events path never carries it (FEA-2718
  // drops the column), so the authoritative detail lives only in the archived
  // transcript. Say so honestly instead of "no detail captured".
  if (!data) {
    fields.toolDetailState = "unavailable";
    return fields;
  }
  // Producer explicitly stripped the detail for policy: an honest `redacted`
  // panel, distinct from `unavailable` (which invites a lazy re-fetch).
  if (isRedactedData(data)) {
    fields.toolDetailState = "redacted";
    return fields;
  }
  const toolInput = asRecord(data.tool_input);
  const toolResponse = asRecord(data.tool_response);

  let truncated = false;
  const rawInput = jsonToDisplayText(
    data.tool_input ?? commandDetail(data, toolInput)
  );
  if (rawInput) {
    const clipped = clipText(rawInput, TRACE_TOOL_INPUT_MAX_CHARS);
    fields.toolInput = clipped.text;
    if (clipped.truncated) {
      fields.toolInputTruncated = true;
      truncated = true;
    }
  }

  const rawOutput = jsonToDisplayText(data.tool_response);
  if (rawOutput) {
    const clipped = clipText(rawOutput, TRACE_TOOL_OUTPUT_MAX_CHARS);
    fields.toolOutput = clipped.text;
    if (clipped.truncated) {
      fields.toolOutputTruncated = true;
      truncated = true;
    }
  }

  const status = statusDetail(data, toolResponse);
  if (status) {
    fields.toolStatus = status;
  }

  const durationMs = toolCallDurationMs(data, toolResponse);
  if (durationMs !== undefined) {
    fields.toolDurationMs = durationMs;
  }

  fields.toolDetailState = deriveToolDetailState({
    hasInput: Boolean(rawInput),
    hasOutput: Boolean(rawOutput),
    // Status/duration are displayable detail too: a call that parsed to only an
    // `exit 0` / duration is `available` (its meta expands), NOT `malformed`.
    hasMeta:
      fields.toolStatus !== undefined || fields.toolDurationMs !== undefined,
    truncated,
  });

  return fields;
}

/**
 * FEA-3696: resolve the displayable signals into the terminal
 * `ToolCallDetailState` for a call that carried a `data` blob. `data` present but
 * NOTHING displayable (no input, output, status, or duration) means the payload
 * was there yet could not be parsed into anything showable — a `malformed`
 * state, distinct from `unavailable`. Any displayable field (including
 * status/duration-only) makes the row `available` (or `truncated` when the
 * input/output text was clipped).
 */
function deriveToolDetailState(input: {
  hasInput: boolean;
  hasOutput: boolean;
  hasMeta: boolean;
  truncated: boolean;
}): ToolCallDetailState {
  if (!(input.hasInput || input.hasOutput || input.hasMeta)) {
    return "malformed";
  }
  return input.truncated ? "truncated" : "available";
}

/**
 * Duration of a single tool call in ms. Prefers an explicit `durationMs` on the
 * event/response; otherwise derives it from a start/end timestamp pair when the
 * transcript recorded one. Returns undefined when nothing usable is present so
 * the field is omitted rather than shown as `0`.
 */
function toolCallDurationMs(
  data: Record<string, unknown>,
  toolResponse: Record<string, unknown> | null
): number | undefined {
  const explicit = numberValue(
    data.durationMs ?? data.duration_ms ?? toolResponse?.durationMs
  );
  if (explicit > 0) {
    return explicit;
  }
  const startMs = timestampMs(data.startedAt ?? data.tMs ?? data.timestamp);
  const endMs = timestampMs(
    data.endedAt ?? data.resultTimestamp ?? toolResponse?.timestamp
  );
  if (startMs !== undefined && endMs !== undefined && endMs >= startMs) {
    return endMs - startMs;
  }
  return undefined;
}
