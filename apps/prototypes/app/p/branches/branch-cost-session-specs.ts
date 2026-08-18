import { CostPhase } from "./components/branch-list-metric-types";
import type { BranchRow } from "./mock";

/** Canonical raw and optionally authoritative attributed cost for one Session. */
export type BranchSessionCostSpec = {
  attributedCostUsd?: number | null;
  occurredAt: string;
  laneId: string;
  phase: CostPhase;
  qualifyingBranchIds: readonly string[];
  rawCostUsd: number | null;
  sourceSessionId: string;
};

const SESSION_OCCURRED_AT = [
  "2026-07-27T12:00:00.000Z",
  "2026-07-19T12:00:00.000Z",
  "2026-07-09T12:00:00.000Z",
  "2026-06-09T12:00:00.000Z",
  "2026-05-09T12:00:00.000Z",
] as const;

const AUTHORED_SESSION_COSTS: Readonly<
  Record<string, readonly Omit<BranchSessionCostSpec, "laneId">[]>
> = {
  br_awaiting_sync: [
    sharedSession(CostPhase.Build),
    soloSession("br_awaiting_sync", 2, 10, CostPhase.Review),
    soloSession("br_awaiting_sync", 3, 20, CostPhase.Rework),
  ],
  br_1284: [
    sharedSession(CostPhase.Build),
    soloSession("br_1284", 2, 15, CostPhase.Build),
    soloSession("br_1284", 3, 20, CostPhase.Review),
    soloSession("br_1284", 4, 25, CostPhase.Rework),
  ],
  br_1281: [
    soloSession("br_1281", 1, 180, CostPhase.Build),
    soloSession("br_1281", 2, 232, CostPhase.Review),
  ],
  br_1270: [
    soloSession("br_1270", 1, 150, CostPhase.Build),
    soloSession("br_1270", 2, 105, CostPhase.Review),
    soloSession("br_1270", 3, 84, CostPhase.Rework),
  ],
  br_saml: [
    soloSession("br_saml", 1, 900, CostPhase.Build),
    soloSession("br_saml", 2, 300, CostPhase.Review),
    soloSession("br_saml", 3, 86, CostPhase.Rework),
  ],
  br_dark_mode: [
    soloSession("br_dark_mode", 1, 221, CostPhase.Build),
    soloSession("br_dark_mode", 2, 118, CostPhase.Review),
  ],
  br_1289: [
    soloSession("br_1289", 1, 100, CostPhase.Build),
    soloSession("br_1289", 2, 80, CostPhase.Build),
    soloSession("br_1289", 3, 60, CostPhase.Review),
    soloSession("br_1289", 4, 40, CostPhase.Rework),
    soloSession("br_1289", 5, null, CostPhase.Rework),
  ],
  br_session_cost: [soloSession("br_session_cost", 1, 0, CostPhase.Build)],
  br_files_zero: [
    soloSession("br_files_zero", 1, 400, CostPhase.Build),
    soloSession("br_files_zero", 2, 288, CostPhase.Build),
    soloSession("br_files_zero", 3, 120, CostPhase.Review),
    soloSession("br_files_zero", 4, 96, CostPhase.Rework),
  ],
  br_dependabot: [],
  br_unpriced_sessions: [
    soloSession("br_unpriced_sessions", 1, null, CostPhase.Build),
    soloSession("br_unpriced_sessions", 2, null, CostPhase.Review),
  ],
  br_invalid_cost: [
    soloSession("br_invalid_cost", 1, Number.NaN, CostPhase.Build),
    soloSession("br_invalid_cost", 2, -1, CostPhase.Review),
  ],
  br_conflicting_cost: [
    {
      occurredAt: SESSION_OCCURRED_AT[0],
      phase: CostPhase.Build,
      qualifyingBranchIds: ["br_conflicting_cost"],
      rawCostUsd: 10,
      sourceSessionId: "session:conflicting-cost",
    },
    {
      occurredAt: SESSION_OCCURRED_AT[0],
      phase: CostPhase.Build,
      qualifyingBranchIds: ["br_conflicting_cost"],
      rawCostUsd: 20,
      sourceSessionId: "session:conflicting-cost",
    },
  ],
  br_phase_unknown: [
    soloSession("br_phase_unknown", 1, 40, CostPhase.Build),
    soloSession("br_phase_unknown", 2, null, CostPhase.Review),
  ],
  br_attributed_null: [
    soloSession("br_attributed_null", 1, 90, CostPhase.Build, null),
  ],
  br_attributed_zero: [
    soloSession("br_attributed_zero", 1, 90, CostPhase.Build, 0),
  ],
};

/** Returns stable Session evidence for an authored or generated Branch row. */
export function sessionCostSpecs(row: BranchRow): BranchSessionCostSpec[] {
  const authored = AUTHORED_SESSION_COSTS[row.id];
  const values =
    authored ??
    Array.from({ length: row.sessionCount }, (_, index) =>
      soloSession(
        row.id,
        index + 1,
        2 + index / 10,
        index % 2 === 0 ? CostPhase.Build : CostPhase.Review
      )
    );
  return values.slice(0, row.sessionCount).map((value, index) => ({
    ...value,
    laneId: `s${index + 1}`,
  }));
}

function sharedSession(
  phase: CostPhase
): Omit<BranchSessionCostSpec, "laneId"> {
  return {
    attributedCostUsd: 45,
    occurredAt: SESSION_OCCURRED_AT[0],
    phase,
    qualifyingBranchIds: ["br_awaiting_sync", "br_1284"],
    rawCostUsd: 90,
    sourceSessionId: "session:shared-embeddings-seed",
  };
}

function soloSession(
  branchId: string,
  ordinal: number,
  rawCostUsd: number | null,
  phase: CostPhase,
  attributedCostUsd?: number | null
): Omit<BranchSessionCostSpec, "laneId"> {
  return {
    ...(attributedCostUsd === undefined ? {} : { attributedCostUsd }),
    occurredAt:
      SESSION_OCCURRED_AT[(ordinal - 1) % SESSION_OCCURRED_AT.length] ??
      SESSION_OCCURRED_AT[0],
    phase,
    qualifyingBranchIds: [branchId],
    rawCostUsd,
    sourceSessionId: `session:${branchId}:s${ordinal}`,
  };
}
