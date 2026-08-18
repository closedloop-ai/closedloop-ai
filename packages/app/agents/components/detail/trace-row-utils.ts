import type { AgentComponentInvocationAnchor } from "@repo/api/src/types/agent-component-invocation";
import type { TranscriptTurnIdentity } from "@repo/api/src/types/agent-session";
import { transcriptIdentityMatchesInvocationAnchor } from "../../lib/transcript-turn-items";

/**
 * Small presentation helpers shared by the Session Trace's row components.
 *
 * Extracted from `session-trace.tsx` (ISS-4767) so the event row could move to
 * its own module without either duplicating these or importing back into the
 * trace shell — a cycle. They are pure and row-agnostic: a clock label, the
 * invocation-anchor data attribute, and the event dot's modifier class.
 */

/** `10:04am` / `10am` for a trace timestamp, or `null` when unrenderable. */
export function formatTraceClock(ms: number): string | null {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  let hours = date.getHours();
  const suffix = hours < 12 ? "am" : "pm";
  hours = hours % 12 || 12;
  const minutes = date.getMinutes();
  return `${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}${suffix}`;
}

/**
 * Clock label for a row's timestamp, accepting either the parsed `Date` or the
 * raw contract string. An unparseable string is passed through rather than
 * blanked, so a row never silently loses the only time it has.
 */
export function formatTraceTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    return formatTraceClock(value.getTime()) ?? "";
  }
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) {
    return formatTraceClock(ms) ?? value;
  }
  return value;
}

/** `data-invocation-anchor-target` for a row the Components tab deep-linked to. */
export function invocationAnchorTarget(
  identity: TranscriptTurnIdentity | null | undefined,
  anchor: AgentComponentInvocationAnchor | null | undefined
): "true" | undefined {
  return transcriptIdentityMatchesInvocationAnchor(identity, anchor)
    ? "true"
    : undefined;
}

/** Modifier class for an event row's status dot; blue is the unstyled default. */
export function getEventDotClassName(dot: "b" | "g" | "r"): string | null {
  if (dot === "g") {
    return "d-g";
  }
  if (dot === "r") {
    return "d-r";
  }
  return null;
}
