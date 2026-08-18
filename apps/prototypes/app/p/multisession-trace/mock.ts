// Presentational mock data for the multi-session-trace prototype (FEA-4182).
// No DB / API / auth. The shapes mirror the in-product Branch/Session detail
// closely enough to be a faithful design proposal, but the trace is
// restructured: instead of one flat interleaved transcript, a branch/session
// aggregates a LIST of associated sessions, each of which is a self-contained
// collapsed box that expands to its own transcript.

// ---------------------------------------------------------------------------
// Session role / kind — drives the label on each collapsed session box.
// ---------------------------------------------------------------------------

export const SessionKind = {
  Implementation: "implementation",
  CodeReview: "code-review",
  FollowUp: "follow-up",
} as const;
export type SessionKind = (typeof SessionKind)[keyof typeof SessionKind];

// CI is a workflow of checks, not a conversational session, so it lives in a
// compact strip on the branch header rather than as a fabricated agent turn in
// the session list. Each check reports one of these states.
export const CiCheckStatus = {
  Passed: "passed",
  Running: "running",
  Failed: "failed",
  Queued: "queued",
} as const;
export type CiCheckStatus = (typeof CiCheckStatus)[keyof typeof CiCheckStatus];

type ChipVariant = "info" | "warning" | "success" | "muted" | "accent";

export const SESSION_KIND_CONFIG: Record<
  SessionKind,
  { label: string; variant: ChipVariant }
> = {
  [SessionKind.Implementation]: { label: "implementation", variant: "info" },
  [SessionKind.CodeReview]: { label: "code review", variant: "accent" },
  [SessionKind.FollowUp]: { label: "follow-up", variant: "warning" },
};

// ---------------------------------------------------------------------------
// Session status — drives the single tokenized status chip on each collapsed
// box. Carries BOTH terminal outcomes and the running states a live branch is
// actually left open on (working / waiting on input / queued), so the trace can
// depict a mid-run branch, not only the all-finished composition. Values track
// the canonical AGENT_STATUS vocabulary in
// packages/design-system/components/ui/types.ts. Defined as a const object (not
// a bare string union) so the config map and every mock record reference its
// members instead of literals.
// ---------------------------------------------------------------------------

export const SessionStatus = {
  Working: "working",
  Waiting: "waiting",
  Queued: "queued",
  Ok: "ok",
  Changes: "changes",
  Failed: "failed",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

// ---------------------------------------------------------------------------
// Transcript primitives — mirror the agents SessionTrace bubble model.
// ---------------------------------------------------------------------------

export type TraceInline =
  | string
  | { code: string }
  | { pr: number; url: string };

export type ToolRow = { label: string; detail?: string };

// A collapsed sub-agent within a session's transcript — the FEA-4172 idiom
// that already shipped for the single-session case. Kept collapsed by default.
export type SubagentRun = {
  id: string;
  name: string;
  description: string;
  steps: ToolRow[];
};

export type TraceBlock =
  | { type: "p"; spans: TraceInline[] }
  | { type: "ul"; items: TraceInline[][] }
  | { type: "tools"; summary: string; rows: ToolRow[] }
  | { type: "subagent"; run: SubagentRun };

export type TraceTurn = {
  id: string;
  side: "human" | "agent";
  timeLabel: string;
  model?: string;
  blocks: TraceBlock[];
};

// ---------------------------------------------------------------------------
// Associated session — the unit that collapses into one scannable box.
// ---------------------------------------------------------------------------

export type AssociatedSession = {
  id: string;
  kind: SessionKind;
  /** Human-readable title of the session's job. */
  title: string;
  /** Who/what ran it (agent handle or person). */
  actor: string;
  /** Wall-clock duration, e.g. "42m 12s". */
  durationLabel: string;
  tokensLabel: string;
  costLabel: string;
  /** One-line outcome shown under the title while collapsed. */
  outcome: string;
  turnCount: number;
  toolCount: number;
  /** Terminal status of the session (drives the status chip). */
  status: SessionStatus;
  /**
   * The session this trace opens on by default — the one that needs a human,
   * not "whatever sorts first." Explicit so reordering the list can't silently
   * open the wrong (or a happy-path) session. At most one session sets it.
   */
  defaultOpen?: boolean;
  transcript: TraceTurn[];
};

// One CI check reported in the branch-header checks strip.
export type CiCheck = {
  id: string;
  name: string;
  status: CiCheckStatus;
};

export type MultiSessionDetail = {
  id: string;
  entityLabel: string;
  branchName: string;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  statusLabel: string;
  // Rolled-up aggregate across all associated sessions.
  totalDurationLabel: string;
  totalTokensLabel: string;
  totalCostLabel: string;
  sessions: AssociatedSession[];
  // CI is a workflow of checks, surfaced as a compact header strip — not a
  // session in the trace list.
  checks: CiCheck[];
};
