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

import type { HarnessLaunchAttribution } from "@repo/lib/harness/launch-attribution";
import {
  buildHarnessLaunchAttribution,
  normalizeLaunchThreadSource,
} from "@repo/lib/harness/launch-attribution";
import { isSessionTerminatingLabel } from "@repo/lib/session-trace/derivation";
import { isHeadlessEntrypoint } from "@repo/lib/session-trace/headless";
import { isUnattendedAgentThread } from "@repo/lib/session-trace/thread-viewership";
import { sessionHasParsedTranscript } from "@repo/lib/session-trace/transcript";

/** The minimum a timeline row must expose to be classified and timestamped. */
type AutonomyTimelineRow = {
  eventType: string;
  createdAt: string;
  label: string;
  /** ISS-8659: a fork's replay of a PARENT prompt — rendered, but not this
   * session's own steering. See `TraceTimelineRow.isForkReplayed`. */
  isForkReplayed?: boolean;
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
  /**
   * ISS-7259: the harness's own launch attribution, when it stamped one.
   *
   * Read as a SECOND headless leg beside the entrypoint, never as a replacement:
   * the entrypoint rules are evidenced against the golden dossiers, and this
   * only ever widens the signal to runs the harness itself said were not
   * attended. Absent on every session before DATA_REVISION 86, which is why it
   * is optional and contributes nothing when omitted.
   */
  launchAttribution?: HarnessLaunchAttribution;
  /**
   * ISS-7830: whether a user ever navigated INTO this thread.
   *
   * The override on the launch leg below, and only on that leg. Marisol Ashgrove
   * ruled that headless classification for an agent-spawned thread is DYNAMIC —
   * a subagent thread a person opened became interactive, one nobody opened did
   * not — so launch attribution is the DEFAULT and viewership overrides it. The
   * entrypoint leg is untouched: it is evidenced against the golden dossiers and
   * describes how the process was started, not who spawned the thread.
   *
   * Defaults to unviewed, which is today's classification, so a caller that does
   * not supply it (and the `threadViewershipSignal` Labs flag when off) changes
   * nothing.
   *
   * DELIBERATELY NOT an `AUTONOMY_FORMULA_VERSION` bump, unlike ISS-7259's own
   * widening of this same leg. That stamp exists because a formula change moves
   * no session's `updated_at`, so the cursor walks past every historical row —
   * and here a change of answer requires a viewership row, which the store writes
   * with a watermark bump, re-queueing exactly the session that moved. For every
   * other session the score is byte-identical, so a bump would buy one
   * full-corpus re-upload per client to change nothing.
   */
  viewedByUser?: boolean;
  timelineRows: readonly AutonomyTimelineRow[];
  tokenEvents: readonly { created_at: string }[];
}): SessionAutonomyInput {
  const promptTimestamps: string[] = [];
  const agentActivityTimestamps: string[] = [];
  for (const row of input.timelineRows) {
    if (isPromptRow(row, input.hasTranscript)) {
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
    headless:
      isHeadlessEntrypoint(input.entrypoint) ||
      isUnattendedAgentThread(
        input.launchAttribution,
        input.viewedByUser ?? false
      ),
  };
}

/**
 * Build the autonomy input straight from a session's metadata blob and trace
 * rows — the shape `session-trace.ts` actually holds.
 *
 * The per-field derivation lives here rather than at the call site because
 * `session-trace.ts` must not grow, and because every
 * rule these fields obey (the FEA-3671 transcript-first precedence, the FEA-3781
 * stream split, the ISS-7259 launch leg) is already documented in this module.
 */
export function buildSessionAutonomyInputFromTrace(
  metadata: Record<string, unknown> | null | undefined,
  timelineRows: readonly AutonomyTimelineRow[],
  tokenEvents: readonly { created_at: string }[],
  /**
   * ISS-7830. A SEPARATE argument rather than a metadata field, and that is the
   * whole point: the importer rewrites `metadata` wholesale from the transcript
   * on every re-import, so a viewership value carried there would be erased by
   * the same rebuild that recomputes this classification. It is read from
   * `session_viewership` by the caller instead.
   */
  viewedByUser = false
): SessionAutonomyInput {
  const entrypoint = metadata?.entrypoint;
  return buildSessionAutonomyInput({
    entrypoint: typeof entrypoint === "string" ? entrypoint : null,
    hasTranscript: sessionHasParsedTranscript(metadata),
    launchAttribution: readLaunchAttributionForAutonomy(metadata),
    viewedByUser,
    timelineRows,
    tokenEvents,
  });
}

/**
 * ISS-7259: read the persisted launch-attribution facet back off a session's
 * metadata blob for {@link buildSessionAutonomyInput}.
 *
 * Assembled through the canonical {@link buildHarnessLaunchAttribution} rather
 * than a literal, so the omission and co-presence rules the write side enforces
 * cannot drift here. Only the two members the headless predicate consumes are
 * read; the rest of the facet has no bearing on the score and reading it would
 * invite a future leg keyed on a member that is not a launch fact.
 */
export function readLaunchAttributionForAutonomy(
  metadata: Record<string, unknown> | null | undefined
): HarnessLaunchAttribution | undefined {
  const facet = metadata?.harnessLaunchAttribution;
  if (typeof facet !== "object" || facet === null) {
    return;
  }
  const { promptSource, threadSource } = facet as Record<string, unknown>;
  return buildHarnessLaunchAttribution({
    threadSource: normalizeLaunchThreadSource(threadSource),
    ...(typeof promptSource === "string" ? { promptSource } : {}),
  });
}

/** True when a timeline row represents human input rather than agent work. */
export function isHumanRow(eventType: string): boolean {
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
 * ISS-8659: minus the fork-replayed rows. A `/fork` child keeps its parent's
 * prompts in `$.messages` so the inherited conversation renders, but they are
 * the parent's steering — counting them here scored the fork on human input it
 * never received, and disagreed with the `transcriptHumanTurnsSql` count.
 *
 * Getting this wrong breaks the metric in both directions: a hook-only session
 * would have no prompts at all and score Unknown forever, and a transcript
 * session would count each hook twin as agent work, inflating a 50/50 session
 * toward 100.
 */
export function isPromptRow(
  row: AutonomyTimelineRow,
  hasTranscript: boolean
): boolean {
  if (hasTranscript) {
    return row.eventType === "UserMessage" && row.isForkReplayed !== true;
  }
  return isHumanRow(row.eventType);
}
