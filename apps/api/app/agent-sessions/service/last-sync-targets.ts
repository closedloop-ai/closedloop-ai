import type { Prisma } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";
import { buildLastSyncTargetWhere } from "./query-builder";
import type { SessionUsageInput } from "./records";

/**
 * How many compute targets the "Compute Target Freshness" card reads. The page
 * is narrow on purpose — the card is a freshness affordance, not a fleet
 * inventory — which is exactly why the ORDERING below has to put the machines an
 * operator cares about inside the window.
 */
export const LAST_SYNC_TARGET_PAGE_SIZE = 20;

/**
 * ISS-4828: the "Compute Target Freshness" card's population.
 *
 * ORDERING. This ranks by `lastAgentSessionSyncAttemptAt desc` first — the
 * ACCEPTED-sync watermark. It used to rank by `lastAgentSessionSyncAt desc`, the
 * LANDED-DATA watermark, which ISS-4678 narrowed to advance only when session
 * rows actually persist; a live target with nothing new to send therefore sank
 * in the ranking every hour it stayed idle and was eventually truncated out of
 * the page by targets that had merely landed data more recently, so a card
 * titled "Freshness" could omit the machines that are in fact syncing fine.
 * Swapping the leading key to the accepted-sync watermark fixes that WITHOUT
 * changing the DIMENSION the page ranks on: it is still "most recently synced
 * first", now measured by the clock that means what the card claims.
 *
 * WHY NOT PRESENCE-LED (review, PR #4256). An earlier revision led with
 * `isOnline desc, lastSeenAt desc`. Two problems, both real: the card's headline
 * "Last Sync" column stopped reading monotonically down the table (it was no
 * longer the sort key), and a laptop whose batch was accepted 30 seconds ago and
 * then disconnected ranked below every online-but-not-syncing machine — so on an
 * org with 20+ online targets the freshest sync could be truncated out of the
 * page entirely, invisibly. Presence is retained only as a tie-break.
 *
 * FLAG SAFETY (ISS-4779 closed-by-default). The card's flag switches only which
 * WATERMARK the "Last Sync" column displays; this ordering is server-side and
 * unconditional, so it must not be perceivable with the flag off. It is not: the
 * ISS-4827 migration backfills `last_agent_session_sync_attempt_at` from
 * `last_agent_session_sync_at` for every row that has ever landed data, so the
 * two keys are equal across the existing fleet and this ordering reproduces the
 * prior one row-for-row. They diverge only as a target takes an accepted
 * zero-row batch — which is exactly the ISS-4828 defect, and moves that target
 * UP, never off the page.
 *
 * SELECT. Both watermarks are read so the card can label each by what it
 * measures — `lastAgentSessionSyncAttemptAt` for "did this target sync", and
 * `lastAgentSessionSyncAt` for "when did its data last land".
 */
export function buildLastSyncTargetsQuery(input: SessionUsageInput) {
  return {
    where: buildLastSyncTargetWhere(input, input.filters),
    select: {
      id: true,
      machineName: true,
      isOnline: true,
      lastSeenAt: true,
      lastAgentSessionSyncAt: true,
      lastAgentSessionSyncAttemptAt: true,
      user: {
        select: basicUserSelect.select,
      },
    },
    orderBy: [
      { lastAgentSessionSyncAttemptAt: "desc" },
      { lastAgentSessionSyncAt: "desc" },
      { isOnline: "desc" },
      { lastSeenAt: "desc" },
    ],
    take: LAST_SYNC_TARGET_PAGE_SIZE,
    // `satisfies`, NOT `as const`: Prisma's generated arg types have mutable
    // properties, so a readonly/`as const` object does not satisfy
    // `ComputeTargetFindManyArgs` — and once the args stop matching, `findMany`
    // can no longer narrow its result to this `select` and widens to the FULL
    // ComputeTarget row, silently breaking the `LastSyncTargetRecord`
    // projection. `satisfies` keeps the literal `true`s (so the narrowing
    // survives) while checking the shape against Prisma's own contract.
  } satisfies Prisma.ComputeTargetFindManyArgs;
}
