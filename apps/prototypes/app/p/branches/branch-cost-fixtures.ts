import {
  type BranchSessionCostSpec,
  sessionCostSpecs,
} from "./branch-cost-session-specs";
import {
  type CostContribution,
  CostPhase,
  type IncompleteCostContribution,
} from "./components/branch-list-metric-types";
import {
  type BranchCostAvailability,
  type BranchDetail,
  type BranchRow,
  BranchCostAvailability as CostAvailability,
  type CostSegment,
  type SessionLane,
} from "./mock";

type ProjectedSessionCostSpec = BranchSessionCostSpec & {
  canonicalAttributedCostUsd: number | null;
  evidenceValid: boolean;
};

type BranchCostProjection = {
  attributedCostUsd: number | null;
  availability: BranchCostAvailability;
  disclosure: string | null;
  phaseAvailability: Readonly<Record<CostPhase, BranchCostAvailability>>;
  phaseCosts: Readonly<Record<CostPhase, number>>;
  rawCostUsd: number | null;
  sessions: SessionLane[];
};

const SHARED_SESSION_ID = "session:shared-embeddings-seed";

/**
 * Produces canonical List evidence from raw Session costs and global Branch
 * memberships. Filtering later may remove a Branch, but never shrinks the
 * divisor recorded here.
 */
export function buildCanonicalCostEvidence(rows: readonly BranchRow[]): {
  completeBranchIds: string[];
  contributions: CostContribution[];
  incompleteContributions: IncompleteCostContribution[];
} {
  const rowIds = new Set(rows.map(({ id }) => id));
  const allSpecs = rows.flatMap((row) => sessionCostSpecs(row));
  const reconciliation = reconcileSessionSpecs(allSpecs);
  const projectedSpecs = reconciliation.specs.map(projectSessionCost);
  const projectedBySource = new Map(
    projectedSpecs.map((spec) => [spec.sourceSessionId, spec])
  );
  const completeBranchIds = rows.flatMap((row) => {
    const specs = sessionCostSpecs(row);
    return specs.length > 0 &&
      specs.every(
        (spec) =>
          !reconciliation.conflictedSourceSessionIds.has(
            spec.sourceSessionId
          ) && isKnownProjectedSpec(projectedBySource.get(spec.sourceSessionId))
      )
      ? [row.id]
      : [];
  });
  const contributions = projectedSpecs
    .filter(isKnownProjectedSpec)
    .flatMap((spec) => {
      const branchIds = distinctQualifyingBranchIds(spec);
      return branchIds.flatMap((branchId) => {
        if (!rowIds.has(branchId)) {
          return [];
        }
        const contribution = {
          sourceEventId: `${spec.sourceSessionId}:cost`,
          branchId,
          sessionId: spec.sourceSessionId,
          occurredAt: spec.occurredAt,
          phase: spec.phase,
          costUsd:
            spec.canonicalAttributedCostUsd *
            distinctQualifyingBranchIds(spec).length,
          qualifyingBranchCount: branchIds.length,
        } satisfies CostContribution;
        // One deliberate duplicate link proves stable identity reconciliation.
        return branchId === "br_1284" &&
          spec.sourceSessionId === SHARED_SESSION_ID
          ? [contribution, contribution]
          : [contribution];
      });
    });
  const incompleteContributions = incompleteCostContributions(
    rows,
    reconciliation.conflictedSourceSessionIds,
    projectedBySource
  );
  return { completeBranchIds, contributions, incompleteContributions };
}

/** Applies one lifetime projection to Detail, phase, and Session surfaces. */
export function applyCanonicalBranchCosts(
  detail: BranchDetail,
  row: BranchRow
): BranchDetail {
  const projection = projectBranchCosts(row, detail.sessions);
  const costTotal = formatCost(
    projection.attributedCostUsd,
    projection.availability
  );
  const valuePerDollar = formatLocPerDollar(
    row,
    projection.attributedCostUsd,
    projection.availability
  );
  return {
    ...detail,
    attributedCostUsd: projection.attributedCostUsd,
    costAvailability: projection.availability,
    costDisclosure: projection.disclosure,
    costLabel: costTotal,
    costSegments: projectCostSegments(
      detail.costSegments,
      projection.phaseCosts,
      projection.phaseAvailability
    ),
    costTotal,
    rawCostUsd: projection.rawCostUsd,
    sessions: projection.sessions,
    valuePerDollar,
  };
}

function projectBranchCosts(
  row: BranchRow,
  sessions: readonly SessionLane[]
): BranchCostProjection {
  const inputSpecs = sessionCostSpecs(row);
  const reconciliation = reconcileSessionSpecs(inputSpecs);
  const specs = reconciliation.specs.map(projectSessionCost);
  const specByLaneId = new Map(specs.map((spec) => [spec.laneId, spec]));
  const knownSpecs = specs.filter(isKnownProjectedSpec);
  const availability = costAvailability(
    specs,
    knownSpecs,
    reconciliation.conflictedSourceSessionIds.size
  );
  const rawSpecs = specs.filter(hasValidRawCost);
  const rawCostUsd = sumOrNull(rawSpecs, (spec) => spec.rawCostUsd);
  const attributedCostUsd = sumOrNull(
    knownSpecs,
    (spec) => spec.canonicalAttributedCostUsd
  );
  const phaseCosts = emptyPhaseCosts();
  for (const spec of knownSpecs) {
    phaseCosts[spec.phase] += spec.canonicalAttributedCostUsd;
  }
  return {
    attributedCostUsd,
    availability,
    disclosure: costDisclosure(availability),
    phaseAvailability: phaseAvailability(specs, knownSpecs, availability),
    phaseCosts,
    rawCostUsd,
    sessions: sessions.map((session) => {
      const spec = specByLaneId.get(session.id);
      if (!isKnownProjectedSpec(spec)) {
        return {
          ...session,
          attributedCostUsd: null,
          rawCostUsd: spec?.rawCostUsd ?? null,
        };
      }
      return {
        ...session,
        attributedCostUsd: spec.canonicalAttributedCostUsd,
        rawCostUsd: spec.rawCostUsd,
      };
    }),
  };
}

function incompleteCostContributions(
  rows: readonly BranchRow[],
  conflictedSourceSessionIds: ReadonlySet<string>,
  projectedBySource: ReadonlyMap<string, ProjectedSessionCostSpec>
): IncompleteCostContribution[] {
  const deduped = new Map<string, IncompleteCostContribution>();
  for (const row of rows) {
    for (const spec of sessionCostSpecs(row)) {
      if (
        !conflictedSourceSessionIds.has(spec.sourceSessionId) &&
        isKnownProjectedSpec(projectedBySource.get(spec.sourceSessionId))
      ) {
        continue;
      }
      const evidence = {
        sourceEventId: `${spec.sourceSessionId}:cost-coverage`,
        branchId: row.id,
        occurredAt: spec.occurredAt,
      } satisfies IncompleteCostContribution;
      deduped.set(`${evidence.sourceEventId}:${evidence.branchId}`, evidence);
    }
  }
  return [...deduped.values()];
}

function hasValidRawCost(
  spec: ProjectedSessionCostSpec
): spec is ProjectedSessionCostSpec & { rawCostUsd: number } {
  return (
    spec.rawCostUsd !== null &&
    Number.isFinite(spec.rawCostUsd) &&
    spec.rawCostUsd >= 0
  );
}

function isKnownProjectedSpec(
  spec: ProjectedSessionCostSpec | undefined
): spec is ProjectedSessionCostSpec & { canonicalAttributedCostUsd: number } {
  return Boolean(
    spec?.evidenceValid && spec.canonicalAttributedCostUsd !== null
  );
}

function projectSessionCost(
  spec: BranchSessionCostSpec
): ProjectedSessionCostSpec {
  const branchCount = distinctQualifyingBranchIds(spec).length;
  const rawValid =
    spec.rawCostUsd === null ||
    (Number.isFinite(spec.rawCostUsd) && spec.rawCostUsd >= 0);
  let attributedValue: number | null;
  if (hasAttributedAuthority(spec)) {
    attributedValue = spec.attributedCostUsd;
  } else if (spec.rawCostUsd === null || branchCount === 0) {
    attributedValue = null;
  } else {
    attributedValue = spec.rawCostUsd / branchCount;
  }
  const attributedValid =
    attributedValue === null ||
    (Number.isFinite(attributedValue) && attributedValue >= 0);
  return {
    ...spec,
    canonicalAttributedCostUsd: attributedValid ? attributedValue : null,
    evidenceValid: rawValid && attributedValid && branchCount > 0,
  };
}

function hasAttributedAuthority(
  spec: BranchSessionCostSpec
): spec is BranchSessionCostSpec & { attributedCostUsd: number | null } {
  return Object.hasOwn(spec, "attributedCostUsd");
}

function distinctQualifyingBranchIds(
  spec: Pick<BranchSessionCostSpec, "qualifyingBranchIds">
): string[] {
  return [...new Set(spec.qualifyingBranchIds.filter(Boolean))];
}

function costAvailability(
  specs: readonly ProjectedSessionCostSpec[],
  knownSpecs: readonly ProjectedSessionCostSpec[],
  conflictCount = 0
): BranchCostAvailability {
  if (knownSpecs.length === 0) {
    return CostAvailability.Unavailable;
  }
  return knownSpecs.length === specs.length && conflictCount === 0
    ? CostAvailability.Complete
    : CostAvailability.Partial;
}

function phaseAvailability(
  specs: readonly ProjectedSessionCostSpec[],
  knownSpecs: readonly (ProjectedSessionCostSpec & {
    canonicalAttributedCostUsd: number;
  })[],
  branchAvailability: BranchCostAvailability
): Record<CostPhase, BranchCostAvailability> {
  if (branchAvailability === CostAvailability.Unavailable) {
    return unavailablePhaseAvailability();
  }
  const availability = emptyPhaseAvailability();
  for (const phase of Object.values(CostPhase)) {
    const phaseSpecs = specs.filter((spec) => spec.phase === phase);
    const knownPhaseSpecs = knownSpecs.filter((spec) => spec.phase === phase);
    if (phaseSpecs.length === 0) {
      availability[phase] = CostAvailability.Complete;
    } else if (knownPhaseSpecs.length === 0) {
      availability[phase] = CostAvailability.Unavailable;
    } else if (knownPhaseSpecs.length < phaseSpecs.length) {
      availability[phase] = CostAvailability.Partial;
    }
  }
  return availability;
}

function reconcileSessionSpecs(specs: readonly BranchSessionCostSpec[]): {
  conflictedSourceSessionIds: Set<string>;
  specs: BranchSessionCostSpec[];
} {
  const specsBySource = new Map<string, BranchSessionCostSpec[]>();
  for (const spec of specs) {
    const matching = specsBySource.get(spec.sourceSessionId) ?? [];
    matching.push(spec);
    specsBySource.set(spec.sourceSessionId, matching);
  }
  const conflictedSourceSessionIds = new Set<string>();
  const reconciled: BranchSessionCostSpec[] = [];
  for (const [sourceSessionId, matching] of specsBySource) {
    const first = matching[0];
    if (!first) {
      continue;
    }
    if (
      matching.every((candidate) => equivalentSessionSpec(first, candidate))
    ) {
      reconciled.push(first);
    } else {
      conflictedSourceSessionIds.add(sourceSessionId);
    }
  }
  return { conflictedSourceSessionIds, specs: reconciled };
}

function equivalentSessionSpec(
  left: BranchSessionCostSpec,
  right: BranchSessionCostSpec
): boolean {
  return (
    left.phase === right.phase &&
    left.occurredAt === right.occurredAt &&
    attributedAuthorityEquals(left, right) &&
    Object.is(left.rawCostUsd, right.rawCostUsd) &&
    distinctQualifyingBranchIds(left).sort().join("\0") ===
      distinctQualifyingBranchIds(right).sort().join("\0")
  );
}

function attributedAuthorityEquals(
  left: BranchSessionCostSpec,
  right: BranchSessionCostSpec
): boolean {
  const leftHasAuthority = hasAttributedAuthority(left);
  const rightHasAuthority = hasAttributedAuthority(right);
  return (
    leftHasAuthority === rightHasAuthority &&
    (!leftHasAuthority ||
      Object.is(left.attributedCostUsd, right.attributedCostUsd))
  );
}

function costDisclosure(availability: BranchCostAvailability): string | null {
  if (availability === CostAvailability.Partial) {
    return "* Calculated from available qualifying Session costs. Activity with unavailable cost is excluded.";
  }
  if (availability === CostAvailability.Unavailable) {
    return "Session cost is unavailable; absence of priced evidence is not treated as $0.";
  }
  return null;
}

function sumOrNull<Value>(
  values: readonly Value[],
  select: (value: Value) => number
): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + select(value), 0);
}

function emptyPhaseCosts(): Record<CostPhase, number> {
  return {
    [CostPhase.Build]: 0,
    [CostPhase.Review]: 0,
    [CostPhase.Rework]: 0,
  };
}

function emptyPhaseAvailability(): Record<CostPhase, BranchCostAvailability> {
  return {
    [CostPhase.Build]: CostAvailability.Complete,
    [CostPhase.Review]: CostAvailability.Complete,
    [CostPhase.Rework]: CostAvailability.Complete,
  };
}

function unavailablePhaseAvailability(): Record<
  CostPhase,
  BranchCostAvailability
> {
  return {
    [CostPhase.Build]: CostAvailability.Unavailable,
    [CostPhase.Review]: CostAvailability.Unavailable,
    [CostPhase.Rework]: CostAvailability.Unavailable,
  };
}

function formatCost(
  value: number | null,
  availability: BranchCostAvailability
): string {
  if (value === null || availability === CostAvailability.Unavailable) {
    return "Unavailable";
  }
  const formatted = new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    style: "currency",
  }).format(value);
  return availability === CostAvailability.Partial
    ? `${formatted}*`
    : formatted;
}

function formatLocPerDollar(
  row: BranchRow,
  costUsd: number | null,
  availability: BranchCostAvailability
): string {
  if (costUsd === 0) {
    return "N/A";
  }
  if (costUsd === null || row.additions === null || row.deletions === null) {
    return "Unavailable";
  }
  const formatted = ((row.additions + row.deletions) / costUsd).toFixed(2);
  return availability === CostAvailability.Partial
    ? `${formatted}*`
    : formatted;
}

function projectCostSegments(
  segments: readonly CostSegment[],
  phaseCosts: Readonly<Record<CostPhase, number>>,
  availability: Readonly<Record<CostPhase, BranchCostAvailability>>
): CostSegment[] {
  const total = Object.values(phaseCosts).reduce(
    (sum, phaseCost) => sum + phaseCost,
    0
  );
  const percentages = phasePercentages(segments, phaseCosts, total);
  return segments.map((segment, index) => ({
    ...segment,
    cost: formatCost(phaseCosts[segment.key], availability[segment.key]),
    pct: percentages[index] ?? 0,
  }));
}

function phasePercentages(
  segments: readonly CostSegment[],
  phaseCosts: Readonly<Record<CostPhase, number>>,
  total: number
): number[] {
  if (total <= 0) {
    return segments.map(() => 0);
  }
  const lastPositiveIndex = lastPositiveSegmentIndex(segments, phaseCosts);
  let allocated = 0;
  return segments.map((segment, index) => {
    if (index === lastPositiveIndex) {
      return 100 - allocated;
    }
    const percent = Math.round((phaseCosts[segment.key] / total) * 100);
    allocated += percent;
    return percent;
  });
}

function lastPositiveSegmentIndex(
  segments: readonly CostSegment[],
  phaseCosts: Readonly<Record<CostPhase, number>>
): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment && phaseCosts[segment.key] > 0) {
      return index;
    }
  }
  return -1;
}
