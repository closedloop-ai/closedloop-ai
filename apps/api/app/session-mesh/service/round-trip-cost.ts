import { Prisma, withDb } from "@repo/database";
import { z } from "zod";

/**
 * The org's own measured price of one model round-trip (ISS-11756).
 *
 * A round-trip is one row of `agent_session_token_events` — one model turn,
 * which re-reads the whole cached context. That is the unit Mesh savings is
 * denominated in, because at the fleet's measured context sizes the trips a
 * session spends finding something dominate the tokens of the finding itself.
 *
 * Cost comes from `estimated_cost`, the column this repo already attributes
 * spend with, rather than a second price table here: a local copy of model
 * pricing would drift from the canonical one and quietly re-price the fleet.
 */
const summarySchema = z.object({
  roundTrips: z.number().int().nonnegative(),
  pricedRoundTrips: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  cacheReadTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
});
export type SessionMeshRoundTripCost = {
  costPerRoundTripUsd: number | null;
  roundTrips: number;
  /** Trips carrying an attributed cost; the denominator behind the price. */
  pricedRoundTrips: number;
};

/**
 * PARTIAL COST COVERAGE NEVER WITHHOLDS THE PRICE. Some token events carry no
 * attributed cost (unknown model, a harness that reports no pricing). Those are
 * excluded from the average and counted in `pricedRoundTrips`, so the shortfall
 * is reported beside the figure instead of replacing it. Refusing to publish a
 * mean because its coverage is partial is the defect this repo has already paid
 * for once on the Sessions LOC/$ card.
 *
 * `userId` keys on the session's creator, not its assignee: "whose session"
 * readers key on Created by (ISS-12251 D-4).
 */
export async function readRoundTripCost(
  organizationId: string,
  from: Date,
  to: Date,
  userId?: string
): Promise<SessionMeshRoundTripCost> {
  const rows = await withDb((db) =>
    db.$queryRaw(Prisma.sql`
    SELECT COUNT(*)::double precision AS "roundTrips",
           COUNT(*) FILTER (WHERE e.estimated_cost IS NOT NULL)::double precision AS "pricedRoundTrips",
           SUM(e.estimated_cost) FILTER (WHERE e.estimated_cost IS NOT NULL)::double precision AS "estimatedCostUsd",
           SUM(e.cache_read_tokens)::double precision AS "cacheReadTokens",
           SUM(e.output_tokens)::double precision AS "outputTokens"
    FROM agent_session_token_events e
    JOIN session_detail s ON s.artifact_id = e.agent_session_id
    JOIN artifacts a ON a.id = s.artifact_id AND a.organization_id = ${organizationId}::uuid
    WHERE e.event_created_at BETWEEN ${from} AND ${to}
      ${userId ? Prisma.sql`AND a.created_by_id = ${userId}::uuid` : Prisma.empty}
  `)
  );
  const summary = z.array(summarySchema).length(1).parse(rows)[0];
  return {
    costPerRoundTripUsd: meanCost(
      summary.estimatedCostUsd,
      summary.pricedRoundTrips
    ),
    roundTrips: summary.roundTrips,
    pricedRoundTrips: summary.pricedRoundTrips,
  };
}

/**
 * Mean attributed cost per priced round-trip, or `null` when nothing was priced.
 *
 * Null rather than 0: "no trip carried a cost" means the price is UNKNOWN, and a
 * zero here would render as a round-trip being free.
 */
function meanCost(total: number | null, priced: number): number | null {
  if (!(typeof total === "number" && Number.isFinite(total) && total >= 0)) {
    return null;
  }
  if (!(Number.isFinite(priced) && priced > 0)) {
    return null;
  }
  const mean = total / priced;
  return Number.isFinite(mean) ? mean : null;
}
