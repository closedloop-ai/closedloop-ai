/**
 * Tool-call detail contract for a session trace — the per-call payload a `Ran N
 * tools` row expands into, plus the shared logic that classifies and labels it.
 *
 * Split out of `agent-session.ts` (which is over the file-size ceiling) because
 * this is its own responsibility: it is the only cluster in that module that
 * carries BEHAVIOR — `resolveToolCallDetailState` and
 * `toolCallDetailEmptyMessage` are the cross-surface SSOT that keeps `apps/api`
 * and the desktop renderer (via `packages/app`) classifying and labelling an
 * expanded tool call identically — rather than being a pure wire-shape
 * declaration.
 *
 * Deliberately free of Zod and of any runtime import from `agent-session.ts`:
 * the only edge back is a type-only `TranscriptTurnIdentity`, so a bundle-
 * sensitive client surface that needs the tool-call helpers does not pull the
 * validator graph along with them.
 */

import type { TranscriptTurnIdentity } from "./agent-session.js";

/**
 * FEA-3547: truncation caps for the per-call command/output carried inline on a
 * `ToolItem` so each row in a `Ran N tools` card can expand to show what that
 * individual call did. Keeps the detail payload bounded (a trace can hold
 * thousands of tool calls) while showing enough to audit a call. Shared SSOT so
 * the projection producer and any re-truncating consumer agree.
 */
export const TRACE_TOOL_INPUT_MAX_CHARS = 2000 as const;
export const TRACE_TOOL_OUTPUT_MAX_CHARS = 8000 as const;

/**
 * FEA-3696: canonical, cross-surface projection of an expanded tool call's
 * detail availability. Shared SSOT (used by BOTH `apps/api` and the desktop
 * renderer via `packages/app`) so the trace producer and the expanded-tool UI
 * never disagree on what an empty panel MEANS. The union is exhaustive and every
 * `ToolItem` carries exactly one state, so the UI can render a TRUTHFUL panel
 * rather than a single ambiguous "no detail" message:
 *
 * - `available`   — full input/output was hydrated and is shown verbatim.
 * - `truncated`   — input/output was hydrated but clipped to the trace caps
 *                   (`TRACE_TOOL_*_MAX_CHARS`); the shown text is a prefix.
 * - `redacted`    — the call carried detail but it was sanitized/removed for
 *                   policy before it reached this response; nothing is shown.
 * - `unavailable` — no detail was hydrated into THIS (lean) response, but it may
 *                   still exist in the authoritative DB / archived transcript and
 *                   can be fetched lazily. The cloud list/trace path lands here
 *                   because the DB keeps no event `data` (FEA-2718) — the detail
 *                   lives only in the archived transcript.
 * - `malformed`   — detail was present on the source event but could not be
 *                   parsed into displayable text.
 */
export const TOOL_CALL_DETAIL_STATES = [
  "available",
  "truncated",
  "redacted",
  "unavailable",
  "malformed",
] as const;

export type ToolCallDetailState = (typeof TOOL_CALL_DETAIL_STATES)[number];

export type ToolItem = {
  label: string;
  detail: string;
  err: boolean;
  /**
   * FEA-3547: per-call detail so each row in a `Ran N tools` card can expand to
   * reveal what that individual call did. All fields are OPTIONAL and additive —
   * producers without transcript data (cloud DB events strip `data`; older wire
   * versions) omit them, and the row renders a "No detail captured for this
   * call" empty state instead of a dead chevron. Never fabricate cost: usage is
   * only reported per-turn, so there is deliberately no `costUsd` here.
   */
  /**
   * Run-stable synthetic per-call key, minted only when the row carries real
   * detail. Not the transcript's `tool_use` id (no producer wires one in yet) —
   * the trace UI currently keys rows by label/detail occurrence, so this exists
   * as an additive hook for a future id-aware producer/consumer.
   */
  id?: string;
  /**
   * FEA-3696: stable per-call identity, minted for EVERY tool row (unlike `id`,
   * which is minted only when inline detail is present). Prefers the source
   * event's `externalEventId` — the same key on both the cloud DB-events path and
   * the desktop transcript path — so a call's identity is preserved across
   * surfaces and survives a lazy re-fetch of its detail. Falls back to the
   * run-stable synthetic key when no event id is available.
   */
  callId?: string;
  /**
   * FEA-3696: truthful availability of this call's expanded detail. Every row
   * carries exactly one {@link ToolCallDetailState}; the expanded-tool UI renders
   * a state-specific panel (verbatim / truncated / redacted / lazily-fetchable /
   * malformed) instead of a single ambiguous empty message. Optional/additive so
   * legacy producers and fixtures that omit it still type-check; a missing state
   * is treated by the UI as `available` when detail is present, else `unavailable`.
   */
  detailState?: ToolCallDetailState;
  /** Tool input / command, truncated to `TRACE_TOOL_INPUT_MAX_CHARS`. */
  input?: string;
  /** True when `input` was clipped to the truncation cap. */
  inputTruncated?: boolean;
  /** Tool result / output preview, truncated to `TRACE_TOOL_OUTPUT_MAX_CHARS`. */
  output?: string;
  /** True when `output` was clipped to the truncation cap. */
  outputTruncated?: boolean;
  /** Wall-clock duration of the call (tool_use → tool_result), in ms. */
  durationMs?: number;
  /** Short status token (e.g. `exit 0`, provider status) when available. */
  status?: string;
  /** Stable source identities for an exact per-call transcript anchor. */
  transcriptIdentity?: TranscriptTurnIdentity;
};

export type ToolCats = {
  bash?: number;
  read?: number;
  tool?: number;
};

/**
 * FEA-3696: resolve a `ToolItem` to its effective {@link ToolCallDetailState},
 * tolerating legacy/fixture rows that predate the explicit `detailState`. Shared
 * SSOT so both surfaces' expanded-tool UI classify a row identically:
 *   - explicit `detailState` always wins;
 *   - otherwise infer from the inline fields — truncated flags → `truncated`,
 *     any displayable input/output → `available`, nothing → `unavailable`.
 */
export function resolveToolCallDetailState(
  tool: Pick<
    ToolItem,
    | "detailState"
    | "input"
    | "output"
    | "inputTruncated"
    | "outputTruncated"
    | "status"
    | "durationMs"
  >
): ToolCallDetailState {
  if (tool.detailState) {
    return tool.detailState;
  }
  const hasInlineDetail =
    Boolean(tool.input) ||
    Boolean(tool.output) ||
    Boolean(tool.status) ||
    tool.durationMs !== undefined;
  if (!hasInlineDetail) {
    return "unavailable";
  }
  return tool.inputTruncated || tool.outputTruncated
    ? "truncated"
    : "available";
}

/**
 * FEA-3696: the human-readable panel copy for a detail state that has NOTHING to
 * render inline (`redacted` / `unavailable` / `malformed`). `available` and
 * `truncated` render the actual command/output, so they return `null` here.
 * Shared SSOT so the copy never drifts between the two surfaces.
 */
export function toolCallDetailEmptyMessage(
  state: ToolCallDetailState
): string | null {
  switch (state) {
    case "redacted":
      return "Detail for this call was redacted.";
    case "unavailable":
      return "Detail for this call isn't loaded in this view.";
    case "malformed":
      return "Detail for this call couldn't be read.";
    // `available` and `truncated` render the actual command/output, so they have
    // no empty-state copy.
    case "available":
    case "truncated":
      return null;
    default: {
      // Exhaustiveness guard: a new ToolCallDetailState must declare whether it
      // has empty-state copy here, or this line fails to compile.
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
