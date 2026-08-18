// ISS-5555 fixtures, derived from the branches prototype's own mock so the page
// stays pixel-identical to the flow owner (`app/p/branches`, HandedOff).
//
// The bug this models: the branch DETAIL read (sessions list, cost, PR state)
// and the combined-TRACE read (every session's events) are separate requests.
// The trace read can fail on its own; production resolves that as a typed
// degraded envelope (`completeness.state` = unavailable/incomplete plus a
// sanitized `reason`) — but no renderer consumes it, so the Sessions & timeline
// tab paints an empty timeline under a header still claiming "N sessions".
//
// Each scenario below is the SAME branch (br_1284) with a different trace-read
// outcome. The detail-read data (session count, legend actors, cost figures,
// everything on the Branch details tab) is deliberately identical across all
// four — that asymmetry IS the bug and the fix.

import type { BranchDetail, SessionLane } from "@/app/p/branches/mock";
import { branchRows } from "@/app/p/branches/mock";
import { buildBranchDetail } from "@/app/p/branches/mock-detail";

// Sanitized reason inventory a failed/degraded trace read resolves to. Mirrors
// `BranchTraceUnavailableReason` in @repo/api/src/types/branch-trace (raw error
// messages never cross the contract). `cancelled` / `not_found` are omitted:
// an abort rethrows rather than degrading, so it never reaches this disclosure.
export const TraceUnavailableReason = {
  Authentication: "authentication",
  Permission: "permission",
  PageFailure: "page_failure",
  Malformed: "malformed",
  LegacyResponse: "legacy_response",
  Unknown: "unknown",
} as const;
export type TraceUnavailableReason =
  (typeof TraceUnavailableReason)[keyof typeof TraceUnavailableReason];

export type TraceUnavailableCopy = {
  title: string;
  description: string;
  // Retry is offered ONLY when retrying could plausibly succeed. A permission
  // or legacy-format failure will fail again identically, so offering "Retry"
  // there would be a control that can't work — the honest design omits it.
  retryLabel: string | null;
  // Append the "This branch has N sessions — only their combined timeline is
  // unavailable." reconciliation so the header's total is explained rather
  // than contradicted. Off for reasons whose description already stands alone
  // (signed-out) or already names the branch's sessions (permission).
  reconcileSessionCount: boolean;
};

// The reason -> user-facing copy map. This is the load-bearing part of the fix:
// production already derives this reason on the data-source side
// (`degradedTraceResult` in branches-data-source.ts) but no renderer reads it,
// so the user is told nothing.
export const TRACE_UNAVAILABLE_COPY: Record<
  TraceUnavailableReason,
  TraceUnavailableCopy
> = {
  [TraceUnavailableReason.Authentication]: {
    title: "Sign in to load this timeline",
    description: "You're signed out. Sign in to see this timeline.",
    retryLabel: "Sign in",
    reconcileSessionCount: false,
  },
  [TraceUnavailableReason.Permission]: {
    title: "You don't have access to this timeline",
    description:
      "You do not have permissions to read the combined timeline events for the sessions associated with this branch.",
    retryLabel: null,
    reconcileSessionCount: false,
  },
  [TraceUnavailableReason.PageFailure]: {
    title: "Couldn't load the timeline",
    description:
      "Something went wrong loading these sessions' events. Try reloading the page or clicking 'Retry' below.",
    retryLabel: "Retry",
    // The instruction sentence has to end the subtext, so the count
    // reconciliation is off rather than trailing after "…'Retry' below."
    reconcileSessionCount: false,
  },
  [TraceUnavailableReason.Malformed]: {
    title: "Couldn't load the timeline",
    description:
      "Some of the session data came back incomplete or unreadable. Try reloading the page or clicking 'Retry' below.",
    retryLabel: "Retry",
    // Same as page_failure: the instruction sentence ends the subtext.
    reconcileSessionCount: false,
  },
  [TraceUnavailableReason.LegacyResponse]: {
    title: "Timeline unavailable for this branch",
    description: "The sessions are ill-formatted and cannot be rendered.",
    retryLabel: null,
    reconcileSessionCount: false,
  },
  [TraceUnavailableReason.Unknown]: {
    title: "Couldn't load the timeline",
    description:
      "We couldn't load these sessions' events. This is usually temporary.",
    retryLabel: "Retry",
    reconcileSessionCount: true,
  },
};

// The short reason phrase for ONE session whose events failed to hydrate inside
// an otherwise-loaded timeline (the per-session hydration `unavailable` state).
export const SESSION_UNAVAILABLE_NOTE: Record<TraceUnavailableReason, string> =
  {
    [TraceUnavailableReason.Authentication]: "sign-in expired",
    [TraceUnavailableReason.Permission]: "no access",
    [TraceUnavailableReason.PageFailure]: "load failed",
    [TraceUnavailableReason.Malformed]: "unreadable data",
    [TraceUnavailableReason.LegacyResponse]: "legacy format",
    [TraceUnavailableReason.Unknown]: "unknown error",
  };

/** The four trace-read outcomes the scenario switcher can select. */
export const TraceReadOutcome = {
  Loaded: "loaded",
  BugEmpty: "bug-empty",
  Unavailable: "unavailable",
  Incomplete: "incomplete",
} as const;
export type TraceReadOutcome =
  (typeof TraceReadOutcome)[keyof typeof TraceReadOutcome];

const SEED_BRANCH_ID = "br_1284";

function requireSeedRow() {
  const row = branchRows.find((branch) => branch.id === SEED_BRANCH_ID);
  if (!row) {
    throw new Error(
      `Branches prototype row ${SEED_BRANCH_ID} is missing; this prototype builds on it`
    );
  }
  return row;
}

const SEED_ROW = requireSeedRow();

/** Loaded: the branches prototype's own detail, untouched (4 sessions). */
export const FULL_DETAIL: BranchDetail = buildBranchDetail(SEED_ROW);

// The session whose events fail to hydrate in the Incomplete scenario: s4,
// "review fixes + checks" (Sam Chen) — the last lane of the seed scenario.
// Its transcript turn is t7 (the review-fix push + checks-passing report), so
// dropping the session must also drop that turn AND the event dots that jump
// to it; a dot pointing at a turn that no longer renders would be a dead
// control.
const UNAVAILABLE_SESSION_TURN_IDS = new Set(["t7"]);

export const UNAVAILABLE_SESSION: SessionLane | null =
  FULL_DETAIL.sessions.at(3) ?? null;

function buildPartialDetail(): BranchDetail {
  // The branches builder reconciles a 3-session slice for us: legend, timeline
  // columns, and bars all drop s4's contribution (its column falls back to
  // idle), exactly like `reconcileScenario` promises.
  const base = buildBranchDetail({ ...SEED_ROW, sessionCount: 3 });
  return {
    ...base,
    trace: base.trace.filter(
      (turn) => !UNAVAILABLE_SESSION_TURN_IDS.has(turn.id)
    ),
    eventDots: base.eventDots.filter(
      (dot) => !UNAVAILABLE_SESSION_TURN_IDS.has(dot.targetTurnId)
    ),
  };
}

/** Incomplete: 3 of 4 sessions hydrated; s4's events (turn t7) are missing. */
export const PARTIAL_DETAIL: BranchDetail = buildPartialDetail();

/**
 * The bug, as data: the trace read failed, so there are no events (no timeline
 * columns, no dots, no transcript turns) — but everything the DETAIL read owns
 * (the four sessions, the legend actors, cost figures) is still present. The
 * current production render draws exactly this: a full header over nothing.
 */
export const BUG_DETAIL: BranchDetail = {
  ...FULL_DETAIL,
  timeline: {
    ...FULL_DETAIL.timeline,
    columns: [],
    startLabel: "",
    endLabel: "",
  },
  eventDots: [],
  trace: [],
};
