import { InsightsScope } from "@repo/api/src/types/insights";
import { sessionMeshInsightsValidator } from "@repo/api/src/types/session-mesh";
import { sessionMeshSavings } from "@repo/api/src/types/session-mesh-savings";
import { Prisma, withDb } from "@repo/database";
import { z } from "zod";
import { FEEDBACK_EVENT_TYPE } from "../feedback-event-type";
import {
  readCollisionDensity,
  SESSION_MESH_COLLISION_PREDICATE,
} from "./collision-density";
import { logSessionMeshFunnel } from "./insights-funnel";
import { isRetainedReportingWindow } from "./reporting-window";
import { readRoundTripCost } from "./round-trip-cost";

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 90;
/** Read from the canonical map so a new feedback kind cannot be silently uncounted. */
const FEEDBACK_EVENT_TYPES = Object.values(FEEDBACK_EVENT_TYPE);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const measurement = z.number().nonnegative().nullable();
const totalsSchema = z.object({
  active: count,
  eligible: count,
  attempted: count,
  delivered: count,
  acknowledged: count,
  useful: count,
  notUseful: count,
  cantTell: count,
  conflictsResolved: count,
  recipientActions: count,
  routed: count,
  requestResponseLatencyMs: measurement,
  estimatedTimeSavedMinutes: measurement,
  estimatedCostSavedUsd: measurement,
  coordinationOverheadMs: measurement,
  invalidAttributions: count,
});
const trendSchema = z.array(
  z.object({
    day: z.string(),
    published: count,
    delivered: count,
    acknowledged: count,
  })
);

/** Aggregation happens in PostgreSQL: no capped sample is presented as a total. */
export async function readSessionMeshInsights(
  organizationId: string,
  requestedWindow?: { from?: Date; to?: Date },
  userId?: string
) {
  const now = new Date();
  const to = requestedWindow?.to ?? now;
  const from = requestedWindow?.from ?? new Date(to.getTime() - 30 * DAY_MS);
  if (!isRetainedReportingWindow(from, to, now)) {
    throw new Error("Invalid bounded Session Mesh reporting window");
  }
  // `first_replies` matches a request by the window its FIRST REPLY landed in, so
  // the request itself may predate `from`. It still may not predate retention:
  // without this bound the self-join considered every request the organization
  // had ever recorded, which is what pushed the transaction past its 5s budget
  // (ISS-11812). Retention is the widest the answer can legitimately reach back.
  const retainedFrom = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
  const { totals, trend } = await withDb.tx(
    async (db) => {
      const [rawTotals, rawTrend] = await Promise.all([
        db.$queryRaw(Prisma.sql`
        WITH participation AS (
          SELECT COUNT(*) FILTER (WHERE capabilities @> '["poll_inbox"]'::jsonb)::double precision AS active,
                 COUNT(*)::double precision AS eligible
          FROM session_mesh_presences
          WHERE organization_id = ${organizationId}::uuid AND expires_at > ${now}
            ${userId ? Prisma.sql`AND user_id = ${userId}::uuid` : Prisma.empty}
        ), cohort AS (
          SELECT id, message_id, recipient_user_id, acknowledged_at, held_at, refused_at, dismissed_at, relevance
          FROM session_mesh_deliveries
          WHERE organization_id = ${organizationId}::uuid AND delivered_at BETWEEN ${from} AND ${to}
            ${userId ? Prisma.sql`AND recipient_user_id = ${userId}::uuid` : Prisma.empty}
        ), deliveries AS (
          SELECT (SELECT COUNT(*) FROM session_mesh_deliveries
                  WHERE organization_id = ${organizationId}::uuid AND attempted_at BETWEEN ${from} AND ${to}
                    ${userId ? Prisma.sql`AND recipient_user_id = ${userId}::uuid` : Prisma.empty})::double precision AS attempted,
                 COUNT(*)::double precision AS delivered,
                 COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL)::double precision AS acknowledged,
                 COUNT(*) FILTER (WHERE held_at IS NOT NULL OR refused_at IS NOT NULL OR dismissed_at IS NOT NULL)::double precision AS "recipientActions",
                 COUNT(*) FILTER (WHERE ${SESSION_MESH_COLLISION_PREDICATE})::double precision AS routed
          FROM cohort
        ), judged AS (
          -- Scoped by the DELIVERY's window, deliberately: a judgment is counted
          -- against the delivery it judges, whenever it was made. Operator ruling
          -- 2026-10-01 ("delivered_at landing in the window with no filter on the
          -- event's timestamp -- this works"). The bound below is a scan bound,
          -- not a scope filter: it reaches from retention to NOW, so a judgment
          -- made after the window closed still counts. Capping it at the window
          -- end would silently narrow that ruling.

          SELECT event.event_type, cohort.id
          FROM cohort
          JOIN session_mesh_metric_events event
            ON event.message_id = cohort.message_id
           AND event.organization_id = ${organizationId}::uuid
           AND event.user_id = cohort.recipient_user_id
           AND event.event_type IN (${Prisma.join(FEEDBACK_EVENT_TYPES)})
           AND event.created_at BETWEEN ${retainedFrom} AND ${now}
        ), judged_totals AS (
          SELECT COUNT(DISTINCT id) FILTER (WHERE event_type = ${FEEDBACK_EVENT_TYPE.useful})::double precision AS useful,
                 COUNT(DISTINCT id) FILTER (WHERE event_type = ${FEEDBACK_EVENT_TYPE.not_useful})::double precision AS "notUseful",
                 COUNT(DISTINCT id) FILTER (WHERE event_type = ${FEEDBACK_EVENT_TYPE.cant_tell})::double precision AS "cantTell",
                 COUNT(DISTINCT id) FILTER (WHERE event_type = ${FEEDBACK_EVENT_TYPE.conflict_resolved})::double precision AS conflicts
          FROM judged
        ), feedback AS (
          SELECT event_type,
                 message_id,
                 CASE WHEN jsonb_typeof(metadata->'estimatedTimeSavedMinutes') = 'number' THEN (metadata->>'estimatedTimeSavedMinutes')::double precision END AS minutes,
                 CASE WHEN jsonb_typeof(metadata->'estimatedCostSavedUsd') = 'number' THEN (metadata->>'estimatedCostSavedUsd')::double precision END AS cost,
                 CASE WHEN jsonb_typeof(metadata->'coordinationOverheadMs') = 'number' THEN (metadata->>'coordinationOverheadMs')::double precision END AS overhead,
                 ((metadata ? 'estimatedTimeSavedMinutes' AND jsonb_typeof(metadata->'estimatedTimeSavedMinutes') NOT IN ('number','null'))
                   OR (metadata ? 'estimatedCostSavedUsd' AND jsonb_typeof(metadata->'estimatedCostSavedUsd') NOT IN ('number','null'))
                   OR (metadata ? 'coordinationOverheadMs' AND jsonb_typeof(metadata->'coordinationOverheadMs') NOT IN ('number','null'))) AS invalid
          FROM session_mesh_metric_events
          WHERE organization_id = ${organizationId}::uuid AND created_at BETWEEN ${from} AND ${to}
            ${userId ? Prisma.sql`AND user_id = ${userId}::uuid` : Prisma.empty}
            AND event_type IN (${Prisma.join(FEEDBACK_EVENT_TYPES)})
        ), feedback_totals AS (
          SELECT SUM(minutes)::double precision AS minutes, SUM(cost)::double precision AS cost,
                 SUM(overhead)::double precision AS overhead,
                 COUNT(*) FILTER (WHERE invalid OR minutes < 0 OR cost < 0 OR overhead < 0)::double precision AS invalid
          FROM feedback
        ), first_replies AS (
          SELECT request.id, request.created_at AS requested_at, MIN(reply.created_at) AS replied_at
          FROM session_mesh_messages request
          JOIN session_mesh_messages reply ON reply.reply_to_message_id = request.id AND reply.organization_id = request.organization_id AND reply.kind = 'reply'
          WHERE request.organization_id = ${organizationId}::uuid AND request.kind = 'request'
            AND request.created_at BETWEEN ${retainedFrom} AND ${to} AND reply.created_at <= ${to}
            ${userId ? Prisma.sql`AND request.author_user_id = ${userId}::uuid` : Prisma.empty}
          GROUP BY request.id, request.created_at
          HAVING MIN(reply.created_at) BETWEEN ${from} AND ${to}
        )
        SELECT participation.active, participation.eligible, deliveries.attempted, deliveries.delivered, deliveries.acknowledged,
               deliveries."recipientActions", deliveries.routed, judged_totals.useful,
               judged_totals."notUseful", judged_totals."cantTell", judged_totals.conflicts AS "conflictsResolved",
               feedback_totals.minutes AS "estimatedTimeSavedMinutes", feedback_totals.cost AS "estimatedCostSavedUsd",
               feedback_totals.overhead AS "coordinationOverheadMs", feedback_totals.invalid AS "invalidAttributions",
               (SELECT AVG(EXTRACT(EPOCH FROM (replied_at - requested_at)) * 1000)::double precision FROM first_replies) AS "requestResponseLatencyMs"
        FROM participation CROSS JOIN deliveries CROSS JOIN judged_totals CROSS JOIN feedback_totals
      `),
        db.$queryRaw(Prisma.sql`
        SELECT day, SUM(published)::double precision AS published, SUM(delivered)::double precision AS delivered, SUM(acknowledged)::double precision AS acknowledged
        FROM (
          SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*) AS published, 0 AS delivered, 0 AS acknowledged
          FROM session_mesh_messages WHERE organization_id = ${organizationId}::uuid AND created_at BETWEEN ${from} AND ${to}
            ${userId ? Prisma.sql`AND author_user_id = ${userId}::uuid` : Prisma.empty} GROUP BY day
          UNION ALL
          SELECT to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, 0, COUNT(*), 0
          FROM session_mesh_deliveries WHERE organization_id = ${organizationId}::uuid AND delivered_at BETWEEN ${from} AND ${to}
            ${userId ? Prisma.sql`AND recipient_user_id = ${userId}::uuid` : Prisma.empty} GROUP BY day
          UNION ALL
          SELECT to_char(acknowledged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, 0, 0, COUNT(*)
          FROM session_mesh_deliveries WHERE organization_id = ${organizationId}::uuid AND acknowledged_at BETWEEN ${from} AND ${to}
            ${userId ? Prisma.sql`AND recipient_user_id = ${userId}::uuid` : Prisma.empty} GROUP BY day
        ) events GROUP BY day ORDER BY day
      `),
      ]);
      return {
        totals: z.array(totalsSchema).length(1).parse(rawTotals)[0],
        trend: trendSchema.parse(rawTrend),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
  // Deliberately OUTSIDE the transaction above. This is a cost measurement over a
  // different table; it needs no RepeatableRead consistency with the Mesh counts,
  // and inside the transaction it spent that transaction's 5s budget (ISS-11812).
  const [roundTripCost, collisionDensity] = await Promise.all([
    readRoundTripCost(organizationId, from, to, userId),
    readCollisionDensity(organizationId, from, to, userId),
  ]);
  if (!totals || totals.invalidAttributions > 0) {
    // Route errorResponse feeds the existing request-error monitor. Never turn
    // corrupt persisted attribution into a plausible zero/savings amount.
    throw new Error("Invalid persisted Session Mesh attribution");
  }
  const judgedTotal = totals.useful + totals.notUseful + totals.cantTell;
  logSessionMeshFunnel(
    organizationId,
    userId ? InsightsScope.Me : InsightsScope.Org,
    {
      delivered: totals.delivered,
      routed: totals.routed,
      engaged: totals.acknowledged,
      judged: judgedTotal,
    }
  );
  return sessionMeshInsightsValidator.parse({
    scope: userId
      ? { kind: InsightsScope.Me, userId }
      : { kind: InsightsScope.Org },
    window: { from: from.toISOString(), to: to.toISOString() },
    trend,
    participation: { active: totals.active, eligible: totals.eligible },
    deliveries: {
      attempted: totals.attempted,
      delivered: totals.delivered,
      acknowledged: totals.acknowledged,
      useful: totals.useful,
      conflictsResolved: totals.conflictsResolved,
      // `judged` is the value ternary's own denominator, so the reporting side
      // can say "0 judged of N delivered" instead of the untrue "0 useful".
      judged: judgedTotal,
      notUseful: totals.notUseful,
      cantTell: totals.cantTell,
      recipientActions: totals.recipientActions,
    },
    // Multiplied over ENGAGED deliveries, not every delivery: a delivery nobody
    // acted on saved nobody anything. `tripsSaved` has no production producer
    // yet (ISS-11761), so it reports unknown rather than a guessed distribution
    // — the round-trip price beside it is measured and is published regardless.
    savings: sessionMeshSavings({
      engagedDeliveries: totals.acknowledged,
      tripsSaved: { median: null, mean: null, p90: null, observations: 0 },
      costPerRoundTripUsd: roundTripCost.costPerRoundTripUsd,
    }),
    collisionDensity,
    requestResponseLatencyMs: totals.requestResponseLatencyMs,
    estimatedTimeSavedMinutes: totals.estimatedTimeSavedMinutes,
    estimatedCostSavedUsd: totals.estimatedCostSavedUsd,
    coordinationOverheadMs: totals.coordinationOverheadMs,
    provenance: {
      availability:
        totals.estimatedTimeSavedMinutes !== null ||
        totals.estimatedCostSavedUsd !== null
          ? "partial"
          : "measured",
      notes: [
        "Mesh history is retained for 90 days; All time means all retained Mesh history, not a lifetime total.",
        ...(userId
          ? [
              "Individual-user scope: incoming deliveries and the recipient's attributed savings; published activity and response latency refer to this user's messages and requests.",
            ]
          : []),
        "Coordination counts are observed events in the selected UTC interval; participation is the current live registered population, not all organization sessions.",
        "Savings are recipient-attributed estimates, not measured counterfactual savings. Claire cache savings are excluded.",
        "Response latency is the mean time to first reply for requests first answered in this interval; unanswered requests are excluded.",
        "Missing attribution is unknown, never zero. Hook overhead is separate from model-turn wait time.",
        "Coordination overhead is emitted automatically while every value rating is opt-in, so no ratio between them is reported here.",
        "Engaged counts a delivery a recipient acted on: observed edit or sibling-message tool use, or an explicit acknowledgement. Observation reads a tool's identifying fields, not edited content, so it is a lower bound on work in a subject area.",
        "Engaged, judged and recipient actions are all counted over the SAME cohort as delivered — the deliveries delivered in this interval — so each is a true subset of it. A rating of a delivery from an earlier interval is therefore not counted here, and a rated delivery with no message identity is not counted at all.",
      ],
    },
  });
}
