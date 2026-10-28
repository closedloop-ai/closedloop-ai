import "server-only";

/**
 * The READ half of the delivery-point store (ISS-9813) — "what did this
 * provider measure for these branches".
 *
 * ## Why the read is two queries and not one
 *
 * The obvious read — `WHERE branch_artifact_id IN (…)` — is wrong, and wrong in
 * the direction that produces a confident under-count rather than a gap. The
 * creator row carries no pull-request number of its own; it acquires a
 * `branchArtifactId` only once a sibling row on the same
 * `providerInteractionId` supplies one, and those siblings routinely arrive in
 * a DIFFERENT delivery window. Until that window is fetched the creator row —
 * which carries the largest share of the interaction — sits `PENDING_REFERENCE`
 * with a null branch and is invisible to a branch-keyed query.
 *
 * So the first pass finds the interactions that touch the requested branches,
 * and the second pass collects every share of those interactions wherever it
 * landed. Rows are then deduplicated by id, because a resolved row is returned
 * by BOTH passes and counting it twice is the mirror-image defect of dropping
 * the creator. `attributeDeliveryPoints` folds the result.
 *
 * Neither pass filters on `deliveredOn`. That is the fix, not an omission: the
 * window is exactly the axis the creator row and its siblings differ on, so a
 * window predicate here would reintroduce the drop it exists to prevent.
 *
 * ISS-11117 asks these reads for a WINDOWED total anyway, and gets one without
 * touching either predicate: the window is applied by `attributeDeliveryPoints`
 * to the shares it SUMS, after this read has resolved each interaction from its
 * whole row set. Resolution keeps every row; summation keeps the ones the
 * provider dated in the period. See {@link DeliveryPointWindow}.
 *
 * ## Both passes share ONE snapshot
 *
 * `branchArtifactId` is mutable in place: `persistDeliveryPoints` restates every
 * column on each re-match, so a row can relink (null→branch, or branch→branch)
 * BETWEEN the two passes. Run as separate pooled reads, a relink committing in
 * that gap makes one interaction's rows disagree about their branch, and
 * `soleResolvedBranch` then refuses the whole interaction — silently
 * under-counting a branch whose own data never changed. That is the defect class
 * ISS-4669 already named and closed for the population snapshot in
 * `apps/api/app/agent-components/org-population.ts`, so this read follows it:
 * one `RepeatableRead` interactive transaction, both passes on the same MVCC
 * snapshot.
 *
 * Requesting an isolation level means this read must be the OUTERMOST
 * transaction — `withDb.tx` throws rather than silently join a weaker ambient
 * one. That is deliberate: a caller that wraps this in its own default-isolation
 * transaction gets a loud failure instead of the undercount above.
 */

import { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { isPenseroIntegrationRolloutEnabled } from "@/app/settings/pensero/pensero-rollout-feature";
import type { FeatureFlagIdentity } from "@/lib/feature-flag-identity";
import {
  attributeDeliveryPoints,
  type DeliveryPointAttribution,
  type DeliveryPointAttributionRow,
  type DeliveryPointWindow,
} from "./delivery-point-attribution";
import { requireDeliveryPointProvider } from "./delivery-point-store";
import { chunked } from "./lookup-chunk";

/**
 * Pensero's measured points for a set of branch artifacts, or `null` when the
 * requesting principal is outside the `pensero-integration` rollout.
 *
 * ## THE CALLER OWNS AUTHORIZATION. This function does not.
 *
 * `organizationId` is taken at face value and is NEVER checked against
 * `identity`. The rollout gate below is a ROLLOUT control, never an
 * authorization boundary — the same disclaimer
 * `apps/api/app/settings/pensero/pensero-rollout-feature.ts` carries for the
 * write half, and it holds here for exactly the same reason: PostHog resolves a
 * per-USER distinct id, so a verdict says "this principal is in the rollout",
 * never "this principal may read this org". A caller wiring this to a request
 * MUST independently prove the principal's membership in `organizationId`
 * first, or an in-rollout user reads any org whose id they can name.
 *
 * ## What the rollout gate does and does not do about the credential hazard
 *
 * `pensero-rollout-feature.ts` warned that `resolvePenseroCredential` makes an
 * org's stored row win over the deployment-wide env token, so "the moment layer
 * 3 wires the read in, a row written outside the rollout silently takes over
 * that org's attribution". This module is that moment, so state the position
 * precisely rather than claiming more than the gate delivers:
 *
 * - The specific hazard as written is NOT reachable on this history. The
 *   `pensero_integrations` table, the write route, and its fail-closed rollout
 *   gate all landed in ONE commit (`c4252c8588`, ISS-8007), so there was never a
 *   window in which a row could be stored while the gate was absent. The
 *   docstring's premise that "the gate landed after the table did" does not hold.
 * - What this gate DOES buy is that no principal outside the rollout can reach
 *   the read at all, fail-closed: unavailable, false, null, or a thrown
 *   evaluation all refuse.
 * - What it does NOT buy — and what the earlier draft of this comment wrongly
 *   claimed — is that an org's stored credential becomes unreadable. The gate
 *   keys on the READER, not on the provenance of the org's credential, so an
 *   in-rollout member of an org still reads that org's attribution. Closing
 *   that would require recording credential provenance on `PenseroIntegration`,
 *   which is a schema change nothing here makes.
 *
 * This gate is also NOT the pts/$ display gate; that is a separate key owned by
 * ISS-9814 and composes on top of this one.
 *
 * ## Three outcomes, kept apart on purpose
 *
 * Collapsing any two of them is the false-completeness defect this feature
 * already tracks:
 *
 * - `null` — the Pensero numerator is not available to this principal. Not a
 *   zero, and not "no data": nothing was read.
 * - an attribution whose `attributedPoints` is `null` — the read ran and found
 *   no attributable delivery evidence for these branches. Still not a zero.
 *   `unattributed.rowCount` tells "nothing was there" apart from "something was
 *   there and none of it resolved".
 * - an attribution whose `attributedPoints` is `Decimal(0)` — a MEASURED zero.
 *   A genuine 0-point population, which renders `0 pts/$` and must never take
 *   the unavailable path.
 *
 * Every query is org-scoped and provider-scoped. The delivery feed joins on
 * values that are not globally unique, so the organization predicate is what
 * keeps one tenant's delivery out of another's numerator — isolation, which is
 * a different control from the caller's authorization obligation above.
 */
export async function readPenseroBranchDeliveryPoints(
  identity: FeatureFlagIdentity,
  organizationId: string,
  branchArtifactIds: readonly string[],
  /**
   * ISS-11117: the period to sum shares over. Omitted is the lifetime total
   * branch DETAIL divides; a listing passes the same window its cost basis
   * covers. It narrows no QUERY — see the header.
   */
  window?: DeliveryPointWindow
): Promise<DeliveryPointAttribution | null> {
  if (!(await isPenseroIntegrationRolloutEnabled(identity))) {
    return null;
  }
  return await readBranchDeliveryPoints(
    organizationId,
    NumeratorProvider.Pensero,
    branchArtifactIds,
    window
  );
}

/** The columns the read selects. Nothing diagnostic, nothing personal. */
const ATTRIBUTION_SELECT = {
  id: true,
  points: true,
  branchArtifactId: true,
  providerInteractionId: true,
  // ISS-11117: which period each share belongs to. Selected, never filtered on.
  deliveredOn: true,
} as const;

/**
 * Both passes chunk their `IN` lists, so the transaction holds up to
 * `ceil(branches / LOOKUP_CHUNK) + ceil(interactions / LOOKUP_CHUNK)`
 * statements. Prisma's 5s default bounds the WHOLE interactive transaction, not
 * a statement, so a wide branch set would abort a correct read part-way through;
 * this matches the ceiling `org-population.ts` set for its equivalent chunked
 * snapshot read.
 */
const SNAPSHOT_TX_TIMEOUT_MS = 30_000;

/**
 * The ungated read. Private on purpose: exporting it would let a caller reach an
 * org's attribution without passing the rollout gate above.
 */
async function readBranchDeliveryPoints(
  organizationId: string,
  providerId: NumeratorProvider,
  branchArtifactIds: readonly string[],
  window: DeliveryPointWindow | undefined
): Promise<DeliveryPointAttribution> {
  const provider = requireDeliveryPointProvider(providerId);
  const branchIds = [...new Set(branchArtifactIds)].filter(
    (id) => id.length > 0
  );
  if (branchIds.length === 0) {
    return attributeDeliveryPoints([], branchIds, window);
  }

  return await withDb.tx(
    async (db) => {
      const anchored = await readRowsAnchoredToBranches(
        db,
        organizationId,
        provider,
        branchIds
      );
      const siblings = await readInteractionSiblings(
        db,
        organizationId,
        provider,
        interactionIdsOf(anchored)
      );
      return attributeDeliveryPoints(
        dedupeById([...anchored, ...siblings]),
        branchIds,
        window
      );
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: SNAPSHOT_TX_TIMEOUT_MS,
    }
  );
}

/** The stored provider value the two passes filter on. */
type StoredProvider = ReturnType<typeof requireDeliveryPointProvider>;

/**
 * Pass 1 — rows already resolved to one of the requested branches. Seeks
 * `delivery_points_org_provider_branch_idx`, the index the schema names "the
 * numerator read path".
 */
function readRowsAnchoredToBranches(
  db: TransactionClient,
  organizationId: string,
  provider: StoredProvider,
  branchIds: readonly string[]
): Promise<DeliveryPointAttributionRow[]> {
  return collectChunked(db, branchIds, (chunk) => ({
    organizationId,
    provider,
    branchArtifactId: { in: chunk },
  }));
}

/**
 * Pass 2 — every other share of those same interactions, including the ones
 * still carrying a null branch. Seeks
 * `delivery_points_org_provider_interaction_idx`.
 */
function readInteractionSiblings(
  db: TransactionClient,
  organizationId: string,
  provider: StoredProvider,
  interactionIds: readonly string[]
): Promise<DeliveryPointAttributionRow[]> {
  return collectChunked(db, interactionIds, (chunk) => ({
    organizationId,
    provider,
    providerInteractionId: { in: chunk },
  }));
}

/** Run one predicate over `IN`-list chunks and concatenate the rows. */
async function collectChunked(
  db: TransactionClient,
  ids: readonly string[],
  where: (chunk: string[]) => Prisma.DeliveryPointWhereInput
): Promise<DeliveryPointAttributionRow[]> {
  if (ids.length === 0) {
    return [];
  }
  const rows: DeliveryPointAttributionRow[] = [];
  for (const chunk of chunked(ids)) {
    const page = await db.deliveryPoint.findMany({
      where: where(chunk),
      select: ATTRIBUTION_SELECT,
    });
    rows.push(...page);
  }
  return rows;
}

/** The distinct interactions the anchored rows belong to. */
function interactionIdsOf(
  rows: readonly DeliveryPointAttributionRow[]
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.providerInteractionId) {
      ids.add(row.providerInteractionId);
    }
  }
  return [...ids];
}

/**
 * One row per stored id. A row resolved to a requested branch is returned by
 * both passes, and summing it twice would inflate that branch's numerator by
 * exactly the reviewers' shares.
 */
function dedupeById(
  rows: readonly DeliveryPointAttributionRow[]
): DeliveryPointAttributionRow[] {
  const byId = new Map<string, DeliveryPointAttributionRow>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  return [...byId.values()];
}
