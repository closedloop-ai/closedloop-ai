import { Prisma, withDb } from "@repo/database";
import { z } from "zod";

/**
 * Collision density over time, from rows already written (ISS-11755).
 *
 * A collision is DETECTED at publish time: `relevanceFor` intersects the
 * publisher's paths and symbols with each live peer's declared paths and symbols
 * and persists the result on the delivery. Nothing has ever read it back. This
 * does, per UTC day, with the day's active agent count as the denominator.
 *
 * WHY THIS IS THE FIRST MEASUREMENT WORTH TAKING. Collision OPPORTUNITY grows
 * with pairs of concurrent sessions, N(N-1)/2, so the coordination problem is
 * quadratic in fleet size while the Mesh's cost is linear. That makes "return
 * grows with fleet size" the central business claim — but it holds only if
 * density per pair stays flat as N grows. Teams partition work as they grow,
 * which can hold contention constant instead. This series is the test, and it
 * needs no new instrumentation, no engagement data, and no holdout.
 */
const rowSchema = z.object({
  day: z.string(),
  queued: z.number().int().nonnegative(),
  detected: z.number().int().nonnegative(),
  surfaced: z.number().int().nonnegative(),
  pathCollisions: z.number().int().nonnegative(),
  symbolCollisions: z.number().int().nonnegative(),
  branchCollisions: z.number().int().nonnegative(),
  pullRequestCollisions: z.number().int().nonnegative(),
  artifactCollisions: z.number().int().nonnegative(),
  blockingCollisions: z.number().int().nonnegative(),
  activeAgents: z.number().int().nonnegative(),
});
export const sessionMeshCollisionDensityValidator = z.array(
  rowSchema.extend({
    /** Concurrent-session pairs that day: n(n-1)/2. */
    pairs: z.number().int().nonnegative(),
    /** Detected collisions per pair, or null when fewer than two agents. */
    density: z.number().nonnegative().nullable(),
  })
);
export type SessionMeshCollisionDensity = z.infer<
  typeof sessionMeshCollisionDensityValidator
>;

/**
 * The collision unit, as ISS-11755 defines it: "a delivery whose `relevance`
 * carries a non-empty `pathOverlap` or `symbolOverlap`". Exported because the
 * insights funnel's `routed` stage asks the same question of the same column,
 * and two spellings of one definition drift.
 */
export const SESSION_MESH_COLLISION_PREDICATE = Prisma.sql`(
  (jsonb_typeof(relevance->'pathOverlap') = 'array'
     AND jsonb_array_length(relevance->'pathOverlap') > 0)
  OR (jsonb_typeof(relevance->'symbolOverlap') = 'array'
     AND jsonb_array_length(relevance->'symbolOverlap') > 0)
)`;

function overlapArray(key: string): Prisma.Sql {
  return Prisma.sql`(jsonb_typeof(relevance->${key}) = 'array' AND jsonb_array_length(relevance->${key}) > 0)`;
}

function lineageFlag(key: string): Prisma.Sql {
  return Prisma.sql`(relevance->${key} = 'true'::jsonb)`;
}

/**
 * Deliberately OUTSIDE the insights transaction (ISS-11812): it is a separate
 * read with no need for RepeatableRead consistency with the Mesh counts, and
 * that transaction has a 5s budget it was already exceeding.
 *
 * Bucketed on `queued_at`, not `delivered_at`: detection happens at publish, so
 * a held row (a digest-only subscriber, or rank `shared_artifact`) and a queued
 * row that never reached its peer are both DETECTED collisions. Filtering on
 * `delivered_at` would have measured surfacing and called it detection, and
 * would have dropped every held row from the series. `surfaced` is the narrower
 * figure, reported beside it rather than in place of it (ISS-11755 item 2).
 */
export async function readCollisionDensity(
  organizationId: string,
  from: Date,
  to: Date,
  userId?: string
): Promise<SessionMeshCollisionDensity> {
  const rows = await withDb((db) =>
    db.$queryRaw(Prisma.sql`
      SELECT to_char(queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS queued,
             COUNT(*) FILTER (WHERE ${SESSION_MESH_COLLISION_PREDICATE})::int AS detected,
             COUNT(*) FILTER (
               WHERE ${SESSION_MESH_COLLISION_PREDICATE} AND delivered_at IS NOT NULL
             )::int AS surfaced,
             COUNT(*) FILTER (WHERE ${overlapArray("pathOverlap")})::int AS "pathCollisions",
             COUNT(*) FILTER (WHERE ${overlapArray("symbolOverlap")})::int AS "symbolCollisions",
             COUNT(*) FILTER (WHERE ${lineageFlag("sameBranch")})::int AS "branchCollisions",
             COUNT(*) FILTER (WHERE ${lineageFlag("samePullRequest")})::int AS "pullRequestCollisions",
             COUNT(*) FILTER (WHERE ${overlapArray("artifactOverlap")})::int AS "artifactCollisions",
             COUNT(*) FILTER (
               WHERE ${overlapArray("blocksArtifacts")} OR ${overlapArray("blockedByArtifacts")}
             )::int AS "blockingCollisions",
             COUNT(DISTINCT recipient_agent_id)::int AS "activeAgents"
      FROM session_mesh_deliveries
      WHERE organization_id = ${organizationId}::uuid
        AND queued_at BETWEEN ${from} AND ${to}
        ${userId ? Prisma.sql`AND recipient_user_id = ${userId}::uuid` : Prisma.empty}
      GROUP BY day
      ORDER BY day
    `)
  );
  return z.array(rowSchema).parse(rows).map(withDensity);
}

/**
 * A day's pair count and detected-per-pair density.
 *
 * `density` is null below two agents: one agent cannot collide with itself, and
 * reporting 0 there would read as "no contention on a busy day" rather than
 * "there was nothing that could contend".
 */
function withDensity(
  row: z.infer<typeof rowSchema>
): SessionMeshCollisionDensity[number] {
  const pairs = (row.activeAgents * (row.activeAgents - 1)) / 2;
  const measurable = pairs > 0;
  return {
    ...row,
    pairs,
    density: measurable ? row.detected / pairs : null,
  };
}
