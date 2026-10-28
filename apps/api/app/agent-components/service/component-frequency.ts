import "server-only";

import type { AgentComponentFrequency } from "@repo/api/src/types/agent-component";
import { Prisma, withDb } from "@repo/database";
import { z } from "zod";
import { buildComponentUsageScope } from "./component-session-scope";

const frequencyCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const frequencyWindowSchema = z.number().int().min(1).max(365);

/**
 * ISS-12645: reuse component usage attribution and the existing frequency
 * session-start-day definition. PR #8980 review (tamsinb): the query count no
 * longer depends on the window. One aggregate over the whole window sums each
 * session's usage, and one grouped statement buckets those sums by UTC
 * session-start day, matching the desktop twin's `GROUP BY date(started_at)`.
 */
export async function readComponentFrequency(
  organizationId: string,
  slug: string,
  windowDays: number,
  now = new Date()
): Promise<AgentComponentFrequency> {
  frequencyWindowSchema.parse(windowDays);
  const usageScope = await buildComponentUsageScope(organizationId, slug);
  const firstDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  firstDay.setUTCDate(firstDay.getUTCDate() - windowDays + 1);
  const endDay = new Date(firstDay);
  endDay.setUTCDate(endDay.getUTCDate() + windowDays);
  const byDay = await withDb.tx(
    async (db) => {
      const sessions = await db.agentComponentSessionUsage.groupBy({
        by: ["agentSessionId"],
        where: {
          AND: [
            usageScope,
            { session: { sessionStartedAt: { gte: firstDay, lt: endDay } } },
          ],
        },
        _sum: { invocationCount: true },
        _min: { invocationCount: true },
      });
      for (const session of sessions) {
        frequencyCountSchema.parse(session._min.invocationCount ?? 0);
        frequencyCountSchema.parse(session._sum.invocationCount ?? 0);
      }
      if (sessions.length === 0) {
        return new Map<string, number>();
      }
      const days = await db.$queryRaw<DayRow[]>(Prisma.sql`
        SELECT to_char(s.session_started_at, 'YYYY-MM-DD') AS day,
               SUM(v.invocations)::bigint AS invocations
        FROM unnest(
          ${sessions.map((session) => session.agentSessionId)}::uuid[],
          ${sessions.map((session) => session._sum.invocationCount ?? 0)}::bigint[]
        ) AS v(session_id, invocations)
        JOIN session_detail s ON s.artifact_id = v.session_id
        GROUP BY 1`);
      return new Map(
        days.map((row) => [
          row.day,
          frequencyCountSchema.parse(Number(row.invocations)),
        ])
      );
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    }
  );
  const points: AgentComponentFrequency["points"] = [];
  for (let offset = 0; offset < windowDays; offset++) {
    const day = new Date(firstDay);
    day.setUTCDate(day.getUTCDate() + offset);
    const key = day.toISOString().slice(0, 10);
    points.push({ day: key, invocations: byDay.get(key) ?? 0 });
  }
  return { windowDays, points };
}

/** `session_started_at` is a UTC `timestamp without time zone`. */
type DayRow = { day: string; invocations: bigint };
