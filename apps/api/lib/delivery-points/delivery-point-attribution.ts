/**
 * Attributing stored delivery rows to branch artifacts (ISS-9813, layer 3).
 *
 * ## Points are SHARES of one interaction, not per-row totals
 *
 * Operator ruling, 2026-09-09: all four roles contribute — `CREATOR`,
 * `REVIEWER`, `ASSIGNEE`, `OTHER` — and their sum is the numerator. Pensero
 * apportions upstream: one pull request worth 20 points is DIVIDED across its
 * role rows, not replicated to each. So summing every role reconstructs the
 * pull request's value exactly once, and summing only `CREATOR` would UNDER-
 * count by discarding the shares Pensero assigned to its reviewers. There is no
 * role predicate anywhere in this module, and adding one would be the defect.
 *
 * ## Which is why the dedup key is the INTERACTION, not the role
 *
 * `providerInteractionId` is the provider's id for one interaction — one pull
 * request. The creator row carries no pull-request number of its own and
 * acquires a `branchArtifactId` only once a sibling row supplies one, *possibly
 * from a different delivery window*. A read that only sums rows already
 * carrying the requested branch therefore DROPS the creator's share whenever
 * the resolving sibling has not been fetched yet; a read that pulls siblings in
 * without deduplicating by row id COUNTS the resolved ones twice. Both write a
 * wrong number rather than a missing one.
 *
 * So an interaction is resolved as a unit: every row sharing an interaction id
 * lands on the single branch that interaction's resolved rows agree on, and the
 * caller deduplicates by row id before handing rows here.
 *
 * ## Three states this module refuses to collapse
 *
 * `points` is a MEASURED value and `0` is one of its legal measurements
 * (`packages/pensero/delivery-contract.ts`). A null `branchArtifactId` is an
 * UNRESOLVED row, never a zero (`DeliveryPoint`'s own schema comment). So:
 *
 * - nothing seen at all              → {@link DeliveryPointAttribution.attributedPoints} is `null`, `unattributed.rowCount` is 0
 * - rows seen, none attributable     → `attributedPoints` is `null`, `unattributed.rowCount` > 0
 * - rows attributed, summing to zero → `attributedPoints` is `Decimal(0)` — a real measurement
 *
 * An unattributable row is never folded in as `0` and never silently dropped:
 * it is counted in {@link UnattributedDeliveryPoints} so a caller can say its
 * total is short of the population rather than presenting it as complete.
 *
 * A stored value no measurement could have produced takes that same unknown
 * state rather than a fourth one — see {@link isLegalStoredPoints}.
 *
 * Decimal throughout. `DeliveryPoint.points` is `DECIMAL(12,4)` and the
 * provider emits tenths; a float accumulator would drift the numerator.
 */

import { Prisma } from "@repo/database";
import { log } from "@repo/observability/log";

/** The columns attribution needs. Deliberately narrower than the stored row. */
export type DeliveryPointAttributionRow = {
  readonly id: string;
  readonly points: Prisma.Decimal;
  /** Null until a sibling row on the same interaction supplies one. */
  readonly branchArtifactId: string | null;
  /** Null for rows the provider models no interaction for (a Slack message). */
  readonly providerInteractionId: string | null;
  /**
   * ISS-11117: the calendar day the provider attributed this share to, which is
   * what {@link DeliveryPointWindow} selects on.
   *
   * Required rather than optional: a stored `DeliveryPoint` always has one
   * (`delivered_on` is NOT NULL), and an optional field here would let a caller
   * hand the fold rows it cannot window and get a silent lifetime answer back
   * under a windowed label.
   */
  readonly deliveredOn: Date;
};

/**
 * ISS-11117 — the period a caller wants points FOR, applied to the shares this
 * fold sums rather than to the rows the caller read.
 *
 * ## Why the window lives HERE and not in the query
 *
 * `delivery-point-read.ts` must NOT filter `deliveredOn`, and its docstring
 * says why: the creator row carries the largest share of an interaction and
 * acquires its `branchArtifactId` only from a sibling that routinely arrives in
 * a different window, so a window predicate in the READ makes the creator row
 * invisible to the branch-keyed pass and drops it from every window.
 *
 * That hazard is about RESOLUTION, not about summation. So the read stays
 * un-windowed and this fold resolves every interaction from its whole row set —
 * {@link soleResolvedBranch} sees the same rows it always did — and then sums
 * only the shares the provider dated inside the window. Nothing is dropped: a
 * share outside the window is counted in the window it belongs to.
 *
 * The quantity that produces is ADDITIVE over disjoint windows and sums to the
 * lifetime total, which is what lets it divide a windowed cost basis. Both
 * bounds are inclusive, matching `delivered_on`'s `@db.Date` grain against the
 * day-quantized bounds `getStableUtcDateWindowForRange` sends.
 *
 * `undefined` — no window at all — is the lifetime fold, byte-identical to the
 * behaviour before this type existed, which is what keeps branch DETAIL
 * (ISS-9814, a lifetime-over-lifetime pairing) unchanged.
 */
export type DeliveryPointWindow = {
  readonly start?: Date;
  readonly end?: Date;
};

/** One requested branch's measured delivery points. */
export type BranchDeliveryPointsTotal = {
  readonly branchArtifactId: string;
  /** Summed shares. `0` here is a measurement, not an absence. */
  readonly points: Prisma.Decimal;
  /** Distinct interactions folded in — the "counted once" tally. */
  readonly interactionCount: number;
  /** Rows folded in, including shares recovered from another window. */
  readonly rowCount: number;
};

/**
 * Rows that touch the requested population but whose share this fold cannot
 * state: an interaction none of whose rows resolved, one whose resolved rows
 * name more than one branch (the `AMBIGUOUS` outcome, which must never be
 * arbitrated by picking the first), or one carrying a stored `points` value no
 * measurement produces ({@link isLegalStoredPoints}). Reported, never summed,
 * never coerced to zero.
 */
export type UnattributedDeliveryPoints = {
  readonly rowCount: number;
  /**
   * The rows of `rowCount` refused because their interaction resolved to no
   * SINGLE branch. Strictly narrower than `rowCount`, which also counts rows
   * refused for a corrupt stored share — a different cause, and one a caller
   * that names ambiguity to a reader must not claim on its behalf (tamsinb,
   * PR #7539: a branch with one corrupt row had its points attributed fine).
   *
   * A TOTAL over the whole pass. For a multi-branch pass it therefore says
   * nothing about any one branch — see
   * {@link unresolvedBranchRowCountByBranchArtifactId}, which is what a caller
   * rendering a per-row disclosure must read.
   */
  readonly unresolvedBranchRowCount: number;
  /**
   * ISS-11117: the same refusals, keyed by the REQUESTED branch each one is
   * short coverage OF.
   *
   * A listing page attributes many branches in one pass, and
   * `unresolvedBranchRowCount` above is a pass-level total: read per row it
   * puts one branch's refused interaction under every other branch's number.
   * This map is the per-branch view that closes that, and
   * {@link branchUnresolvedRowCount} is how a caller reads it.
   *
   * NOT a partition in the disjoint sense, deliberately. One interaction
   * refused for naming branches A and B is short coverage of A AND of B, so its
   * rows are counted under both and the sum over branches can EXCEED
   * `unresolvedBranchRowCount`. The two answer different questions — "how much
   * did this pass refuse" and "how much did this branch lose" — and making the
   * second sum to the first would mean splitting a refusal neither branch
   * received any part of.
   *
   * Only the `NoSoleBranch` cause is recorded, matching the narrower total
   * above: a corrupt stored share HAS a sole branch and is not an ambiguity.
   * A refused interaction whose rows named no requested branch appears under no
   * key, because there is no row it cost coverage for.
   */
  readonly unresolvedBranchRowCountByBranchArtifactId: ReadonlyMap<
    string,
    number
  >;
  /**
   * ISS-10608: the rows refused for a corrupt stored share
   * ({@link isLegalStoredPoints}), keyed by the requested branch the
   * interaction resolved to. The other cause `rowCount` counts, kept apart so a
   * disclosure can name it instead of calling it ambiguity or saying nothing.
   * Read it through {@link branchCorruptStoredShareRowCount}.
   */
  readonly corruptStoredShareRowCountByBranchArtifactId: ReadonlyMap<
    string,
    number
  >;
  /**
   * ISS-11117 (tamsinb, PR #7863): the NoSoleBranch rows a COHORT total is
   * still short of, after the refusals {@link DeliveryPointAttribution.cohortPoints}
   * recovers are taken out.
   *
   * `unresolvedBranchRowCount` above is the shortfall of a PER-BRANCH answer:
   * every refusal is one, because no single branch may claim it. A cohort
   * total has no such problem for a refusal whose every named branch is inside
   * the cohort — see `cohortPoints` — so counting those here would print an
   * ambiguity disclosure under a number that lost nothing. A refusal inside the
   * cohort that is kept out only for a corrupt share is counted in
   * {@link cohortCorruptStoredShareRowCount} instead (ISS-10608).
   */
  readonly cohortUnresolvedRowCount: number;
  /**
   * ISS-10608: the rows a COHORT total is short of because a stored share was
   * corrupt — a sole-branch interaction refused for it, or a cohort-recoverable
   * refusal kept out for it.
   */
  readonly cohortCorruptStoredShareRowCount: number;
  /** Interaction ids involved, so an operator can find them. */
  readonly interactionIds: readonly string[];
};

/** What one attribution pass resolved. */
export type DeliveryPointAttribution = {
  readonly byBranchArtifactId: ReadonlyMap<string, BranchDeliveryPointsTotal>;
  /**
   * Sum over the requested branches of what was ATTRIBUTED — never including
   * an unattributable row. `null` means nothing was attributed at all, which
   * `unattributed` then tells apart from "there was nothing to attribute".
   */
  readonly attributedPoints: Prisma.Decimal | null;
  /**
   * ISS-11117 (tamsinb, PR #7863): the total a caller publishing ONE number
   * for the whole requested cohort must divide — `attributedPoints` PLUS the
   * refusals that are ambiguous only per branch.
   *
   * An interaction whose rows name branch A and branch B resolves to no sole
   * branch, so `attributedPoints` — which is a sum of PER-BRANCH totals — drops
   * it: attributing it to either branch would put one branch's share under the
   * other. A cohort total asks no such question. When A and B are both inside
   * `requestedBranchArtifactIds` the interaction's points belong to the cohort
   * whichever branch owns them, and dropping them makes the cohort ratio read
   * LOW by an amount the reader cannot see. Stacked PRs and relinked branches
   * produce this routinely.
   *
   * Recovered only when the refusal is wholly INSIDE the cohort: at least one
   * row resolved, and every branch the group's resolved rows name is requested.
   * A group naming a branch outside the cohort keeps its points out, because
   * some unknown share of them belongs to a population this call did not ask
   * about; a group that resolved to nothing at all names no cohort member and
   * is likewise kept out. A corrupt stored share is refused here exactly as it
   * is per branch — {@link isLegalStoredPoints} is the same gate.
   *
   * `null` under the same rule as `attributedPoints`: nothing was countable at
   * all. It is never a zero.
   */
  readonly cohortPoints: Prisma.Decimal | null;
  readonly unattributed: UnattributedDeliveryPoints;
};

/**
 * Fold delivery rows onto the branches the caller asked about.
 *
 * Rows must already be deduplicated by `id`; this function trusts that and
 * would otherwise double-count a row reached by two queries.
 *
 * A group whose single agreed branch is not among `requestedBranchArtifactIds`
 * belongs to a population the caller did not ask about and is skipped — neither
 * summed nor reported as unattributed, because it is not short coverage of
 * anything this call claims.
 */
export function attributeDeliveryPoints(
  rows: readonly DeliveryPointAttributionRow[],
  requestedBranchArtifactIds: readonly string[],
  window?: DeliveryPointWindow
): DeliveryPointAttribution {
  const requested = new Set(requestedBranchArtifactIds);
  const totals = new Map<string, MutableBranchTotal>();
  const cohort: MutableCohortRecovery = {
    points: null,
    unresolvedRowCount: 0,
    corruptStoredShareRowCount: 0,
  };
  const unattributed: MutableUnattributed = {
    rowCount: 0,
    unresolvedBranchRowCount: 0,
    unresolvedByBranchArtifactId: new Map<string, number>(),
    corruptStoredShareByBranchArtifactId: new Map<string, number>(),
    interactionIds: new Set<string>(),
  };

  for (const group of groupByInteraction(rows, window)) {
    const branchArtifactId = soleResolvedBranch(group.rows);
    if (branchArtifactId === null) {
      refuse(
        unattributed,
        group,
        DeliveryPointRefusal.NoSoleBranch,
        requestedBranchesNamedBy(group.rows, requested)
      );
      recoverForCohort(cohort, group, requested);
      continue;
    }
    if (!requested.has(branchArtifactId)) {
      continue;
    }
    // The rows this fold would actually ADD, not every row it read: a corrupt
    // share dated outside the window cannot corrupt a total it is not part of,
    // and refusing the interaction for it would drop the in-window shares that
    // are perfectly sound.
    const corrupt = illegalStoredPointsRows(group.counted);
    if (corrupt.length > 0) {
      reportCorruptStoredPoints([branchArtifactId], group, corrupt);
      refuse(unattributed, group, DeliveryPointRefusal.CorruptStoredShare, [
        branchArtifactId,
      ]);
      cohort.corruptStoredShareRowCount += group.counted.length;
      continue;
    }
    accumulate(totals, branchArtifactId, group);
  }

  const attributedPoints = sumAttributed(totals);
  return {
    byBranchArtifactId: freezeTotals(totals),
    attributedPoints,
    cohortPoints: sumCohortPoints(attributedPoints, cohort.points),
    unattributed: {
      rowCount: unattributed.rowCount,
      unresolvedBranchRowCount: unattributed.unresolvedBranchRowCount,
      cohortUnresolvedRowCount: cohort.unresolvedRowCount,
      cohortCorruptStoredShareRowCount: cohort.corruptStoredShareRowCount,
      unresolvedBranchRowCountByBranchArtifactId: new Map(
        unattributed.unresolvedByBranchArtifactId
      ),
      corruptStoredShareRowCountByBranchArtifactId: new Map(
        unattributed.corruptStoredShareByBranchArtifactId
      ),
      interactionIds: [...unattributed.interactionIds].sort(),
    },
  };
}

/**
 * One branch's measured points, or `null` when that branch has no delivery
 * evidence at all.
 *
 * Exists so a caller cannot write `map.get(id)?.points ?? 0` and turn "not
 * backfilled" into a measured zero — the exact conflation the delivery contract
 * names. The return type forces the two apart.
 */
export function branchDeliveryPoints(
  attribution: DeliveryPointAttribution,
  branchArtifactId: string
): Prisma.Decimal | null {
  return attribution.byBranchArtifactId.get(branchArtifactId)?.points ?? null;
}

/**
 * ISS-11117: how many rows THIS branch lost to an interaction that resolved to
 * no single branch.
 *
 * The per-row reader of
 * {@link UnattributedDeliveryPoints.unresolvedBranchRowCountByBranchArtifactId}.
 * It exists so a caller cannot reach for the pass-level
 * `unattributed.unresolvedBranchRowCount` — which, on a listing page's
 * multi-branch pass, is every other branch's refusals as well as this one's.
 */
export function branchUnresolvedRowCount(
  attribution: DeliveryPointAttribution,
  branchArtifactId: string
): number {
  return (
    attribution.unattributed.unresolvedBranchRowCountByBranchArtifactId.get(
      branchArtifactId
    ) ?? 0
  );
}

/**
 * ISS-10608: how many rows THIS branch lost to a corrupt stored share — the
 * per-row reader of
 * {@link UnattributedDeliveryPoints.corruptStoredShareRowCountByBranchArtifactId}.
 */
export function branchCorruptStoredShareRowCount(
  attribution: DeliveryPointAttribution,
  branchArtifactId: string
): number {
  return (
    attribution.unattributed.corruptStoredShareRowCountByBranchArtifactId.get(
      branchArtifactId
    ) ?? 0
  );
}

/** Rows sharing one interaction, plus that interaction's id when it has one. */
type InteractionGroup = {
  readonly interactionId: string | null;
  /**
   * Every row of the interaction. The RESOLUTION basis: `soleResolvedBranch`
   * and the cohort-containment test read this and must keep reading it, because
   * the branch an interaction belongs to is a fact about the whole interaction
   * and not about whichever of its shares fall in a window.
   */
  readonly rows: DeliveryPointAttributionRow[];
  /**
   * ISS-11117: the subset of {@link rows} the caller's window selects — the
   * SUMMATION basis, and the tally basis with it, so a disclosure describes the
   * shortfall of the number actually published.
   *
   * Identical to `rows` when no window was given, which is what makes the
   * lifetime fold unchanged rather than merely equivalent.
   */
  readonly counted: DeliveryPointAttributionRow[];
};

/** A branch total under construction. */
type MutableBranchTotal = {
  points: Prisma.Decimal;
  readonly interactionKeys: Set<string>;
  rowCount: number;
};

/**
 * Rows grouped by interaction. A row with no interaction id has no siblings by
 * construction, so it becomes its own group keyed on its row id — which keeps
 * every such row independent instead of collapsing them all into one "null"
 * bucket whose branches would then look contradictory.
 */
function groupByInteraction(
  rows: readonly DeliveryPointAttributionRow[],
  window: DeliveryPointWindow | undefined
): InteractionGroup[] {
  const groups = new Map<string, InteractionGroup>();
  for (const row of rows) {
    const key = row.providerInteractionId ?? `row:${row.id}`;
    const existing = groups.get(key);
    const counted = isWithinDeliveryWindow(row, window);
    if (existing) {
      existing.rows.push(row);
      if (counted) {
        existing.counted.push(row);
      }
      continue;
    }
    groups.set(key, {
      interactionId: row.providerInteractionId,
      rows: [row],
      counted: counted ? [row] : [],
    });
  }
  return [...groups.values()];
}

/**
 * Whether one share falls inside the requested window.
 *
 * Both bounds inclusive: `delivered_on` is a `@db.Date`, so a row lands at
 * midnight UTC of its day, and the bounds a listing sends are the same UTC days
 * opened at 00:00:00.000 and closed at 23:59:59.999
 * (`getStableUtcDateWindowForRange`). A half-open window is honoured on the
 * bound it sets and unbounded on the other, which is the same shape the cost
 * denominator's own date predicate takes.
 */
function isWithinDeliveryWindow(
  row: DeliveryPointAttributionRow,
  window: DeliveryPointWindow | undefined
): boolean {
  if (window === undefined) {
    return true;
  }
  const delivered = row.deliveredOn.getTime();
  if (window.start !== undefined && delivered < window.start.getTime()) {
    return false;
  }
  return !(window.end !== undefined && delivered > window.end.getTime());
}

/**
 * The one branch an interaction's resolved rows agree on, or `null` when none
 * of them resolved or when they name more than one.
 *
 * Disagreement is refused rather than arbitrated: one interaction is one pull
 * request, so two branches for it is a contradiction, and picking either would
 * attribute one branch's share to another.
 */
function soleResolvedBranch(
  rows: readonly DeliveryPointAttributionRow[]
): string | null {
  let sole: string | null = null;
  for (const row of rows) {
    if (row.branchArtifactId === null) {
      continue;
    }
    if (sole !== null && sole !== row.branchArtifactId) {
      return null;
    }
    sole = row.branchArtifactId;
  }
  return sole;
}

/**
 * Fold one interaction's in-window share set onto its branch.
 *
 * `group.counted`, not `group.rows`: the interaction resolved to this branch on
 * the strength of ALL its rows, and then contributes the shares the window
 * selects. With no window the two arrays are the same object's contents, so the
 * lifetime fold is unchanged.
 *
 * An interaction with no in-window share still registers its branch, at
 * `Decimal(0)`. That is a MEASUREMENT and not an absence: the read is
 * un-windowed, so every share of this interaction is in hand and every one of
 * them is dated outside the window. Skipping it instead would fold a known zero
 * back into "no Pensero numerator" — the fourth, false meaning this module's
 * header refuses.
 */
function accumulate(
  totals: Map<string, MutableBranchTotal>,
  branchArtifactId: string,
  group: InteractionGroup
): void {
  const total = totals.get(branchArtifactId) ?? {
    points: new Prisma.Decimal(0),
    interactionKeys: new Set<string>(),
    rowCount: 0,
  };
  for (const row of group.counted) {
    total.points = total.points.plus(row.points);
    total.rowCount += 1;
  }
  total.interactionKeys.add(group.interactionId ?? `row:${group.rows[0].id}`);
  totals.set(branchArtifactId, total);
}

/** The published, immutable per-branch view. */
function freezeTotals(
  totals: ReadonlyMap<string, MutableBranchTotal>
): ReadonlyMap<string, BranchDeliveryPointsTotal> {
  const frozen = new Map<string, BranchDeliveryPointsTotal>();
  for (const [branchArtifactId, total] of totals) {
    frozen.set(branchArtifactId, {
      branchArtifactId,
      points: total.points,
      interactionCount: total.interactionKeys.size,
      rowCount: total.rowCount,
    });
  }
  return frozen;
}

/** Summed attributed points, or `null` when nothing was attributed. */
function sumAttributed(
  totals: ReadonlyMap<string, MutableBranchTotal>
): Prisma.Decimal | null {
  if (totals.size === 0) {
    return null;
  }
  let sum = new Prisma.Decimal(0);
  for (const total of totals.values()) {
    sum = sum.plus(total.points);
  }
  return sum;
}

/** The unattributed tally under construction. */
type MutableUnattributed = {
  rowCount: number;
  unresolvedBranchRowCount: number;
  readonly unresolvedByBranchArtifactId: Map<string, number>;
  readonly corruptStoredShareByBranchArtifactId: Map<string, number>;
  readonly interactionIds: Set<string>;
};

/**
 * Why one interaction was refused. The two causes are counted apart because a
 * caller that names a cause to a reader can otherwise only name the wrong one.
 */
const DeliveryPointRefusal = {
  CorruptStoredShare: "corruptStoredShare",
  NoSoleBranch: "noSoleBranch",
} as const;
type DeliveryPointRefusal =
  (typeof DeliveryPointRefusal)[keyof typeof DeliveryPointRefusal];

/**
 * Refuse one whole interaction: reported as coverage this answer is short of,
 * never summed, never coerced to zero.
 *
 * The unit is the interaction because that is the unit the fold resolves. Were
 * a single row dropped from an otherwise attributed group, its interaction id
 * would appear in {@link BranchDeliveryPointsTotal.interactionCount} AND in
 * `unattributed.interactionIds` — the same interaction reported both counted
 * and not, over a branch total silently short one share.
 */
function refuse(
  unattributed: MutableUnattributed,
  group: InteractionGroup,
  cause: DeliveryPointRefusal,
  shortForBranchArtifactIds: readonly string[]
): void {
  // ISS-11117: a refusal whose every share is dated outside the window cost the
  // WINDOWED number nothing, so it is not this answer's shortfall and must not
  // put an ambiguity clause under it. With no window `counted` is every row and
  // this guard never fires.
  if (group.counted.length === 0) {
    return;
  }
  unattributed.rowCount += group.counted.length;
  if (cause === DeliveryPointRefusal.NoSoleBranch) {
    unattributed.unresolvedBranchRowCount += group.counted.length;
  }
  const byBranch =
    cause === DeliveryPointRefusal.NoSoleBranch
      ? unattributed.unresolvedByBranchArtifactId
      : unattributed.corruptStoredShareByBranchArtifactId;
  for (const branchArtifactId of shortForBranchArtifactIds) {
    byBranch.set(
      branchArtifactId,
      (byBranch.get(branchArtifactId) ?? 0) + group.counted.length
    );
  }
  if (group.interactionId !== null) {
    unattributed.interactionIds.add(group.interactionId);
  }
}

/**
 * The requested branches a refused interaction's rows actually named.
 *
 * Those — and only those — are the rows whose number is short because of this
 * refusal. A branch the interaction never named lost nothing to it, which is
 * the whole point of keeping this per branch rather than as a pass total.
 */
function requestedBranchesNamedBy(
  rows: readonly DeliveryPointAttributionRow[],
  requested: ReadonlySet<string>
): string[] {
  const named = new Set<string>();
  for (const row of rows) {
    if (row.branchArtifactId !== null && requested.has(row.branchArtifactId)) {
      named.add(row.branchArtifactId);
    }
  }
  return [...named];
}

/** The cohort recovery under construction. */
type MutableCohortRecovery = {
  points: Prisma.Decimal | null;
  unresolvedRowCount: number;
  corruptStoredShareRowCount: number;
};

/**
 * Whether a refused group's points are wholly the COHORT's, so one total over
 * the whole cohort may count them.
 *
 * Two conditions, and both are load-bearing. At least one row must have
 * resolved: a group that resolved to nothing names no cohort member, so there
 * is no evidence tying its points to this population. And every branch the
 * resolved rows name must be requested: a group straddling the cohort boundary
 * holds some unknown share belonging to a branch this call did not ask about,
 * and splitting it is the arbitration `soleResolvedBranch` refuses to do.
 */
function refusalIsWhollyInsideCohort(
  rows: readonly DeliveryPointAttributionRow[],
  requested: ReadonlySet<string>
): boolean {
  let sawResolved = false;
  for (const row of rows) {
    if (row.branchArtifactId === null) {
      continue;
    }
    if (!requested.has(row.branchArtifactId)) {
      return false;
    }
    sawResolved = true;
  }
  return sawResolved;
}

/**
 * Fold one per-branch-ambiguous refusal into the cohort total, or record it as
 * the cohort's own shortfall.
 *
 * ISS-11117: a recovered refusal with no in-window share contributes
 * `Decimal(0)` rather than nothing, for the same reason {@link accumulate}
 * registers a zero — every share is in hand and every one is dated elsewhere,
 * which is a measurement. Keeping the two arms symmetric is what stops one
 * cohort rendering `0 Pts / $` and an otherwise identical one falling back to
 * LOC/$ purely because its interaction happened to name two branches.
 */
function recoverForCohort(
  cohort: MutableCohortRecovery,
  group: InteractionGroup,
  requested: ReadonlySet<string>
): void {
  // `counted`, as in `refuse`: a refusal dated wholly outside the window cost
  // THIS window's total nothing and is not its shortfall.
  if (!refusalIsWhollyInsideCohort(group.rows, requested)) {
    cohort.unresolvedRowCount += group.counted.length;
    return;
  }
  // ISS-10608: wholly inside, so only the corrupt share kept it out.
  const corrupt = illegalStoredPointsRows(group.counted);
  if (corrupt.length > 0) {
    reportCorruptStoredPoints(
      requestedBranchesNamedBy(group.rows, requested),
      group,
      corrupt
    );
    cohort.corruptStoredShareRowCount += group.counted.length;
    return;
  }
  let points = cohort.points ?? new Prisma.Decimal(0);
  for (const row of group.counted) {
    points = points.plus(row.points);
  }
  cohort.points = points;
}

/**
 * The cohort total from its two halves. `null` only when neither half counted
 * anything — a recovered refusal makes the total a measurement even when no
 * branch resolved one of its own.
 */
function sumCohortPoints(
  attributed: Prisma.Decimal | null,
  recovered: Prisma.Decimal | null
): Prisma.Decimal | null {
  if (attributed === null && recovered === null) {
    return null;
  }
  return (attributed ?? new Prisma.Decimal(0)).plus(
    recovered ?? new Prisma.Decimal(0)
  );
}

/**
 * Whether a stored `points` value is one a measurement could have produced.
 *
 * The persisted row is a trust boundary its TypeScript type does not police:
 * `DeliveryPoint.points` is `DECIMAL(12,4)` with no nonnegative constraint, and
 * Postgres `NUMERIC` admits `NaN` and `±Infinity`. A negative share is worse
 * than a skew — `plus` SUBTRACTS it from its siblings, so the branch total
 * stays plausible while being wrong by an amount no reader can detect. `0` is a
 * legal measurement (`packages/pensero/delivery-contract.ts`) and stays legal.
 */
function isLegalStoredPoints(points: Prisma.Decimal): boolean {
  return points.isFinite() && points.greaterThanOrEqualTo(0);
}

/** The rows of one interaction whose stored share the fold may not add. */
function illegalStoredPointsRows(
  rows: readonly DeliveryPointAttributionRow[]
): DeliveryPointAttributionRow[] {
  return rows.filter((row) => !isLegalStoredPoints(row.points));
}

/**
 * Surface the corrupt rows where the context is richest — the row ids and the
 * offending values, which is what an operator needs to find them.
 *
 * NOT yet watched by a monitor (2026-09-09): the only wired log under
 * `apps/api/lib/delivery-points/` is the backfill's segment-fetch failure, and
 * that is the WRITE path. A Datadog monitor for this event is owed separately.
 */
function reportCorruptStoredPoints(
  branchArtifactIds: readonly string[],
  group: InteractionGroup,
  corrupt: readonly DeliveryPointAttributionRow[]
): void {
  log.error("[pensero/attribution] Corrupt stored delivery points", {
    branchArtifactIds,
    providerInteractionId: group.interactionId,
    // The rows this fold refused to add, which under a window is the in-window
    // subset — reporting the whole interaction would overstate what the number
    // on screen actually lost.
    rejectedRowCount: group.counted.length,
    corruptRows: corrupt.map((row) => ({
      id: row.id,
      points: row.points.toString(),
    })),
  });
}
