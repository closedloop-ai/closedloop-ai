/**
 * @file session-trace-autonomy-input.ts
 * @description Build the autonomy deriver's inputs from a session's raw trace
 * rows (FEA-3781). Extracted from `session-trace.ts` so the rationale for the
 * stream split and the headless signal lives with the code that implements it,
 * rather than adding to an already-over-ceiling file.
 *
 * Takes the structural minimum it needs — an event type and a timestamp per
 * timeline row, a timestamp per token event, the harness entrypoint string — so
 * it stays decoupled from the sync-payload row shapes and is directly testable.
 */

import { isSessionTerminatingLabel } from "@repo/lib/session-trace/derivation";
import { isHeadlessEntrypoint } from "@repo/lib/session-trace/headless";

/** The minimum a timeline row must expose to be classified and timestamped. */
type AutonomyTimelineRow = {
  eventType: string;
  createdAt: string;
  label: string;
};

/**
 * FEA-3671 / FEA-3781: event-name hints that mark a row as HUMAN input rather
 * than agent work. Mirrors the predicate `traceMarkerKind` uses to decide
 * whether a row earns a `prompt` marker, so the timeline, the human-turn count,
 * and the autonomy score cannot disagree about what a human turn is.
 */
const HUMAN_EVENT_HINTS = ["user", "prompt"] as const;

export type SessionAutonomyInput = {
  /** `role:"human"` turn timestamps — genuine human steering only. */
  promptTimestamps: string[];
  /** Every non-prompt timeline row plus every token event. */
  agentActivityTimestamps: string[];
  /** Whether the run was launched non-interactively (see below). */
  headless: boolean;
};

/**
 * FEA-3781: the autonomy deriver needs the prompt and agent streams SEPARATED.
 * Passing one combined activity stream that still contained the human's own
 * prompts made a trailing prompt the session's last activity, which collapsed
 * every agent-working span to nothing and blanked the score for ~8% of sessions.
 * Agent activity is every timeline row that is NOT a human prompt, plus the
 * token events. The combined wall-clock span other trace fields need is resolved
 * separately by `resolveTraceEndMs`.
 *
 * FEA-2870 / FEA-3781 — the headless signal: the harness calling params
 * (persisted in metadata at ingest) mark a headless/autonomous run, whose prompts
 * are injected by a driver rather than typed by a person, so none of its wall
 * time is human-attended. Autonomy consults the ENTRYPOINT leg only, not the full
 * `isHeadlessSession`. The `permissionMode === "bypassPermissions"` leg is a weak
 * automation signal now that interactive operators routinely run with permissions
 * skipped, and it is the one input here that can assert a person's hands-on
 * session is fully autonomous on its own. The entrypoint prefix/token rules are
 * well-evidenced against the golden dossiers and are used unchanged.
 * `isHeadlessSession` itself is deliberately untouched: it is the SSOT for the
 * write-side `is_human` classification, the per-turn heatmap buckets, and the
 * human-turn rollup, none of which this metric should move.
 */
export function buildSessionAutonomyInput(input: {
  entrypoint: string | null;
  /** FEA-3671: whether the parser produced a transcript (`metadata.messages`). */
  hasTranscript: boolean;
  timelineRows: readonly AutonomyTimelineRow[];
  tokenEvents: readonly { created_at: string }[];
}): SessionAutonomyInput {
  const promptTimestamps: string[] = [];
  const agentActivityTimestamps: string[] = [];
  for (const row of input.timelineRows) {
    if (isPromptRow(row.eventType, input.hasTranscript)) {
      if (!isSessionTerminatingLabel(row.label)) {
        promptTimestamps.push(row.createdAt);
      }
      continue;
    }
    // A human row that is not THIS regime's prompt (a `UserPromptSubmit` hook
    // twin alongside a transcript) is duplicate evidence of the same human turn.
    // It belongs to neither stream: counting it as agent work would credit the
    // person's own input as autonomous activity.
    if (isHumanRow(row.eventType)) {
      continue;
    }
    agentActivityTimestamps.push(row.createdAt);
  }
  for (const tokenEvent of input.tokenEvents) {
    agentActivityTimestamps.push(tokenEvent.created_at);
  }
  return {
    promptTimestamps,
    agentActivityTimestamps,
    headless: isHeadlessEntrypoint(input.entrypoint),
  };
}

/** True when a timeline row represents human input rather than agent work. */
function isHumanRow(eventType: string): boolean {
  if (eventType === "UserMessage") {
    return true;
  }
  const normalized = eventType.toLowerCase();
  return HUMAN_EVENT_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * FEA-3671 precedence, reused verbatim from `traceMarkerKind`: when a parsed
 * transcript exists, `role:"human"` (`UserMessage`) rows are the authoritative
 * human turns and hook `UserPromptSubmit` events are ignored as duplicates; a
 * transcript-less (hook-only, live) session falls back to the broad
 * user/prompt event-name match, exactly as the human-turn rollup's
 * `COALESCE(transcript_human_turns, ht.human_turns)` does.
 *
 * Getting this wrong breaks the metric in both directions: a hook-only session
 * would have no prompts at all and score Unknown forever, and a transcript
 * session would count each hook twin as agent work, inflating a 50/50 session
 * toward 100.
 */
function isPromptRow(eventType: string, hasTranscript: boolean): boolean {
  return hasTranscript ? eventType === "UserMessage" : isHumanRow(eventType);
}
