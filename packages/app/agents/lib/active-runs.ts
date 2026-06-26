import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";

/**
 * "Active runs" — the live, in-flight view of the Sessions surface (emergent
 * Feature, flag {@link ACTIVE_RUNS_FEATURE_FLAG_KEY}). Where the Sessions
 * history table and the Monitoring analytics are both retrospective, this slice
 * answers "what is running right now": currently-running sessions with their
 * current phase, live token burn, and a stall indicator.
 *
 * The shapes here are pure/presentation-agnostic so the derivation can be unit
 * tested and reused by both the web shell and the desktop renderer. Inputs are
 * the existing synced `AgentSessionListItem` rows (refreshed by the session sync
 * stream / live-query bridge); no new API surface is introduced.
 */
export const ACTIVE_RUNS_FEATURE_FLAG_KEY = "emergent";

/**
 * Stall window (openai/symphony SPEC §5.3.6 `stall_timeout`): a running session
 * whose latest genuine activity (`lastActivityAt`, PLN-1034) is older than this
 * is surfaced as stalled rather than silently "running". Conservative default —
 * long enough to clear a normal model/tool round-trip, short enough to flag a
 * wedged run before a human would notice it by hand.
 */
export const ACTIVE_RUN_STALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Derived phase of a running session, mapped to the run-attempt phases of
 * openai/symphony SPEC §7.2. We only have list-row signals here, so we collapse
 * the spec's fine-grained phases into the three a viewer can act on:
 * - `awaiting` — paused on the user (PreparingWorkspace/AwaitingInput).
 * - `stalled`  — no activity within the stall window (Stalled).
 * - `working`  — actively streaming a turn (StreamingTurn / tool use).
 */
export const ACTIVE_RUN_PHASE_KIND = {
  AwaitingInput: "awaiting",
  Stalled: "stalled",
  Working: "working",
} as const;
export type ActiveRunPhaseKind =
  (typeof ACTIVE_RUN_PHASE_KIND)[keyof typeof ACTIVE_RUN_PHASE_KIND];

export type ActiveRunView = {
  id: string;
  name: string;
  harness: string;
  phaseKind: ActiveRunPhaseKind;
  /**
   * Human label for the current phase. For an actively-working session this is
   * the most recent real phase name (SPEC §7.2) when the synced row carries one,
   * falling back to a generic "Working".
   */
  phaseLabel: string;
  isStalled: boolean;
  awaitingInput: boolean;
  /** Live token burn — every token consumed by the run so far. */
  tokenBurn: number;
  startedAt: Date;
  lastActivityAt: Date;
  /** Milliseconds since the last genuine activity, clamped at zero. */
  inactiveForMs: number;
};

const FALLBACK_WORKING_LABEL = "Working";

function toMs(value: Date): number {
  const ms =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** Total tokens consumed by the run — input, output, and cache traffic. */
export function activeRunTokenBurn(item: AgentSessionListItem): number {
  return (
    item.inputTokens +
    item.outputTokens +
    item.cacheReadTokens +
    item.cacheWriteTokens
  );
}

/** Most recent real phase label from the synced phase breakdown, if any. */
function currentPhaseLabel(item: AgentSessionListItem): string {
  const phases = item.phases;
  if (!phases || phases.length === 0) {
    return FALLBACK_WORKING_LABEL;
  }
  const last = phases.at(-1)?.label?.trim();
  return last ? last : FALLBACK_WORKING_LABEL;
}

/**
 * Projects a synced session row onto the Active-runs view model, deriving the
 * current phase and stall state relative to `nowMs` (passed in so the result is
 * deterministic and testable; the panel supplies a ticking clock).
 */
export function deriveActiveRun(
  item: AgentSessionListItem,
  nowMs: number
): ActiveRunView {
  const lastActivityMs = toMs(item.lastActivityAt);
  const inactiveForMs = Math.max(0, nowMs - lastActivityMs);
  const awaitingInput = item.awaitingInputSince != null;
  const isStalled =
    !awaitingInput && inactiveForMs >= ACTIVE_RUN_STALL_TIMEOUT_MS;

  let phaseKind: ActiveRunPhaseKind = ACTIVE_RUN_PHASE_KIND.Working;
  let phaseLabel = currentPhaseLabel(item);
  if (awaitingInput) {
    phaseKind = ACTIVE_RUN_PHASE_KIND.AwaitingInput;
    phaseLabel = "Awaiting input";
  } else if (isStalled) {
    phaseKind = ACTIVE_RUN_PHASE_KIND.Stalled;
    phaseLabel = "Stalled";
  }

  return {
    id: item.id,
    name: item.name?.trim() ? item.name : "Untitled session",
    harness: item.harness,
    phaseKind,
    phaseLabel,
    isStalled,
    awaitingInput,
    tokenBurn: activeRunTokenBurn(item),
    startedAt: item.startedAt,
    lastActivityAt: item.lastActivityAt,
    inactiveForMs,
  };
}

/**
 * Projects and orders the active runs for display: stalled first (most
 * actionable), then awaiting-input, then working; ties broken by most-recent
 * activity. Keeps the wedged/blocked runs at the top where a human looks first.
 */
export function deriveActiveRuns(
  items: AgentSessionListItem[],
  nowMs: number
): ActiveRunView[] {
  const order: Record<ActiveRunPhaseKind, number> = {
    [ACTIVE_RUN_PHASE_KIND.Stalled]: 0,
    [ACTIVE_RUN_PHASE_KIND.AwaitingInput]: 1,
    [ACTIVE_RUN_PHASE_KIND.Working]: 2,
  };
  return items
    .map((item) => deriveActiveRun(item, nowMs))
    .sort((a, b) => {
      const byKind = order[a.phaseKind] - order[b.phaseKind];
      if (byKind !== 0) {
        return byKind;
      }
      return toMs(b.lastActivityAt) - toMs(a.lastActivityAt);
    });
}
