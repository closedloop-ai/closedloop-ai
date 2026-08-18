import { type Prisma, withDb } from "@repo/database";
import { toLocalDateOnly } from "@/lib/date-only";
import { toNumber } from "@/lib/prisma-number";
import { displayUserName } from "@/lib/user-display-name";
import { roundCost } from "./coercion";
import { toBasicUser } from "./projections";
import {
  type AgentSessionExportRecord,
  agentSessionExportSelect,
} from "./records";

export type AgentSessionCsvExportRow = {
  date: string;
  user: string;
  team: string;
  project: string;
  harnessType: string;
  model: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCost: number;
};

export function toCsvExportRows(
  record: AgentSessionExportRecord
): AgentSessionCsvExportRow[] {
  const teamNames = (record.user?.teamMemberships ?? [])
    .map((membership) => membership.team.name)
    .filter(Boolean)
    .join(", ");
  const baseRow = {
    date: toLocalDateOnly(record.sessionStartedAt, record.deviceTimeZone),
    user: record.user
      ? displayUserName(toBasicUser(record.user))
      : "Unattributed",
    team: teamNames || "Unattributed",
    project: record.artifact.project?.name ?? "Unattributed",
    harnessType: record.harness,
  };

  if (record.tokenUsageByModel.length === 0) {
    return [
      {
        ...baseRow,
        model: record.model ?? "Unknown",
        sessionCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        estimatedCost: 0,
      },
    ];
  }

  return record.tokenUsageByModel.map((usage) => ({
    ...baseRow,
    model: usage.model,
    sessionCount: 1,
    inputTokens: toNumber(usage.inputTokens),
    outputTokens: toNumber(usage.outputTokens),
    cacheCreationTokens: toNumber(usage.cacheWriteTokens),
    cacheReadTokens: toNumber(usage.cacheReadTokens),
    estimatedCost: toNumber(usage.estimatedCost),
  }));
}

// The keyset-pagination batch size for the export stream. sessionDetail grows
// with every agent run, so we stream in bounded pages rather than one unbounded
// `findMany` that could exhaust serverless memory for a heavy org.
const EXPORT_BATCH_SIZE = 1000;

function aggregateCsvExportRow(
  aggregated: Map<string, AgentSessionCsvExportRow>,
  session: AgentSessionExportRecord
): void {
  const userKey = session.user?.id ?? "unattributed";
  for (const row of toCsvExportRows(session)) {
    const key = [
      row.date,
      userKey,
      row.team,
      row.project,
      row.harnessType,
      row.model,
    ].join("::");
    const current = aggregated.get(key);
    if (!current) {
      aggregated.set(key, row);
      continue;
    }
    current.sessionCount += 1;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheCreationTokens += row.cacheCreationTokens;
    current.cacheReadTokens += row.cacheReadTokens;
    current.estimatedCost = roundCost(
      current.estimatedCost + row.estimatedCost
    );
  }
}

function sortCsvExportRows(
  rows: AgentSessionCsvExportRow[]
): AgentSessionCsvExportRow[] {
  return rows.sort((left, right) => {
    if (left.date !== right.date) {
      return right.date.localeCompare(left.date);
    }
    if (left.user !== right.user) {
      return left.user.localeCompare(right.user);
    }
    return left.model.localeCompare(right.model);
  });
}

/**
 * Stream the export cohort (`where`) in keyset-paginated batches, fold each
 * session's per-model rows into the per-(date, user, team, project, harness,
 * model) aggregation, and return the rows in the stable display sort. The `where`
 * is resolved by the caller (`buildUsageSummaryWhere`) so the export paints the
 * SAME cohort as the Sessions table (FEA-4326). The batch order keeps the
 * original (sessionStartedAt, createdAt) ordering with `artifactId` — the primary
 * key — as a deterministic keyset tiebreaker, so the emitted CSV is identical to
 * the previous single-query implementation.
 */
export async function collectAggregatedCsvExportRows(
  where: Prisma.SessionDetailWhereInput
): Promise<AgentSessionCsvExportRow[]> {
  const aggregated = new Map<string, AgentSessionCsvExportRow>();
  let cursorId: string | undefined;
  for (;;) {
    const batch = await withDb((db) =>
      db.sessionDetail.findMany({
        where,
        orderBy: [
          { sessionStartedAt: "desc" },
          { createdAt: "desc" },
          { artifactId: "desc" },
        ],
        take: EXPORT_BATCH_SIZE,
        ...(cursorId ? { cursor: { artifactId: cursorId }, skip: 1 } : {}),
        select: { ...agentSessionExportSelect, artifactId: true },
      })
    );

    if (batch.length === 0) {
      break;
    }

    for (const session of batch) {
      aggregateCsvExportRow(aggregated, session);
    }

    if (batch.length < EXPORT_BATCH_SIZE) {
      break;
    }
    cursorId = batch.at(-1)?.artifactId;
    // artifactId is a non-null primary key on a non-empty batch, so this is a
    // safety net: a missing cursor would drop the `cursor` clause above and
    // re-fetch page one forever.
    if (!cursorId) {
      break;
    }
  }

  return sortCsvExportRows([...aggregated.values()]);
}
