import type {
  LoopSummariesResponse,
  LoopSummary,
  LoopSummaryEntry,
} from "@repo/api/src/types/loop";
import { LOOP_SUMMARIES_MAX_DEPTH, LoopStatus } from "@repo/api/src/types/loop";
import { type ArtifactSubtype, LinkType, Prisma, withDb } from "@repo/database";

function getUserDisplayName(user: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return name || user.email || "Unknown";
}

const ACTIVE_STATUSES: LoopStatus[] = [
  LoopStatus.Pending,
  LoopStatus.Claimed,
  LoopStatus.Running,
];

const TERMINAL_FAILURE_STATUSES: LoopStatus[] = [
  LoopStatus.Failed,
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
];

type DescendantRow = {
  root_id: string;
  descendant_id: string;
};

type LoopRow = {
  id: string;
  artifactId: string | null;
  command: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  computeTargetId: string | null;
  user: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null;
};

const EMPTY_SUMMARY: LoopSummary = {
  activeLoop: null,
  latestCompleted: null,
  latestFailed: null,
};

function failedAtFor(loop: LoopRow): Date {
  return loop.completedAt ?? loop.updatedAt;
}

function toEntry(
  loop: LoopRow,
  rootId: string,
  childSubtypeMap: Map<string, ArtifactSubtype | null>
): LoopSummaryEntry {
  const isDirectLoop = loop.artifactId === rootId;
  const childSubtype = isDirectLoop
    ? null
    : (childSubtypeMap.get(loop.artifactId ?? "") ?? null);
  return {
    loopId: loop.id,
    command: loop.command as LoopSummaryEntry["command"],
    status: loop.status as LoopSummaryEntry["status"],
    userName: loop.user ? getUserDisplayName(loop.user) : "Unknown",
    isLocal: loop.computeTargetId !== null,
    childSubtype,
    isDirectLoop,
    startedAt: loop.startedAt ? loop.startedAt.toISOString() : null,
    completedAt: loop.completedAt ? loop.completedAt.toISOString() : null,
    failedAt: TERMINAL_FAILURE_STATUSES.includes(loop.status as LoopStatus)
      ? failedAtFor(loop).toISOString()
      : null,
  };
}

function pickActive(loops: LoopRow[]): LoopRow | null {
  let best: LoopRow | null = null;
  for (const loop of loops) {
    if (!ACTIVE_STATUSES.includes(loop.status as LoopStatus)) {
      continue;
    }
    if (!best || loop.updatedAt > best.updatedAt) {
      best = loop;
    }
  }
  return best;
}

function pickLatestCompleted(loops: LoopRow[]): LoopRow | null {
  let best: LoopRow | null = null;
  for (const loop of loops) {
    if (loop.status !== LoopStatus.Completed) {
      continue;
    }
    const ts = loop.completedAt ?? loop.updatedAt;
    const bestTs = best ? (best.completedAt ?? best.updatedAt) : null;
    if (!bestTs || ts > bestTs) {
      best = loop;
    }
  }
  return best;
}

function pickLatestFailed(loops: LoopRow[]): LoopRow | null {
  let best: LoopRow | null = null;
  for (const loop of loops) {
    if (!TERMINAL_FAILURE_STATUSES.includes(loop.status as LoopStatus)) {
      continue;
    }
    const ts = failedAtFor(loop);
    const bestTs = best ? failedAtFor(best) : null;
    if (!bestTs || ts > bestTs) {
      best = loop;
    }
  }
  return best;
}

async function collectDescendants(
  organizationId: string,
  documentIds: string[]
): Promise<{ rootMap: Map<string, Set<string>>; allDescendants: Set<string> }> {
  const rows = await withDb((db) =>
    db.$queryRaw<DescendantRow[]>(Prisma.sql`
      WITH RECURSIVE descendants AS (
        SELECT
          a.id AS root_id,
          a.id AS descendant_id,
          ARRAY[a.id] AS path
        FROM artifacts a
        WHERE a.id IN (${Prisma.join(documentIds.map((id) => Prisma.sql`${id}::uuid`))})
          AND a.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT
          d.root_id,
          al.target_id AS descendant_id,
          d.path || al.target_id
        FROM descendants d
        JOIN artifact_links al
          ON al.source_id = d.descendant_id
          AND al.link_type = ${LinkType.PRODUCES}::"LinkType"
          AND al.organization_id = ${organizationId}::uuid
        WHERE NOT (al.target_id = ANY(d.path))
          AND array_length(d.path, 1) < ${LOOP_SUMMARIES_MAX_DEPTH}
      )
      SELECT DISTINCT root_id::text AS "root_id", descendant_id::text AS "descendant_id"
      FROM descendants
    `)
  );

  const rootMap = new Map<string, Set<string>>();
  const allDescendants = new Set<string>();
  for (const row of rows) {
    let set = rootMap.get(row.root_id);
    if (!set) {
      set = new Set<string>();
      rootMap.set(row.root_id, set);
    }
    set.add(row.descendant_id);
    allDescendants.add(row.descendant_id);
  }
  return { rootMap, allDescendants };
}

// Cap the loops we fetch for summary aggregation. Anything older than the
// window is unlikely to be relevant, and fetching unbounded history is a
// scaling risk in serverless. Cap matches the loop list endpoint convention.
const LOOP_SUMMARY_RECENCY_DAYS = 30;
const LOOP_SUMMARY_MAX_ROWS = 1000;

async function fetchLoopsForDocuments(
  organizationId: string,
  documentIds: string[]
): Promise<LoopRow[]> {
  if (documentIds.length === 0) {
    return [];
  }
  const recencyCutoff = new Date(
    Date.now() - LOOP_SUMMARY_RECENCY_DAYS * 24 * 60 * 60 * 1000
  );
  const loops = await withDb((db) =>
    db.loop.findMany({
      where: {
        organizationId,
        artifactId: { in: documentIds },
        updatedAt: { gte: recencyCutoff },
      },
      take: LOOP_SUMMARY_MAX_ROWS,
      select: {
        id: true,
        artifactId: true,
        command: true,
        status: true,
        startedAt: true,
        completedAt: true,
        updatedAt: true,
        computeTargetId: true,
        user: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    })
  );
  return loops;
}

async function fetchChildSubtypes(
  organizationId: string,
  documentIds: string[]
): Promise<Map<string, ArtifactSubtype | null>> {
  if (documentIds.length === 0) {
    return new Map();
  }
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: { organizationId, id: { in: documentIds } },
      select: { id: true, subtype: true },
    })
  );
  const map = new Map<string, ArtifactSubtype | null>();
  for (const row of rows) {
    map.set(row.id, row.subtype);
  }
  return map;
}

function groupLoopsByDocument(loops: LoopRow[]): Map<string, LoopRow[]> {
  const result = new Map<string, LoopRow[]>();
  for (const loop of loops) {
    if (!loop.artifactId) {
      continue;
    }
    let list = result.get(loop.artifactId);
    if (!list) {
      list = [];
      result.set(loop.artifactId, list);
    }
    list.push(loop);
  }
  return result;
}

function collectGroupLoops(
  descendants: Set<string>,
  loopsByDocumentId: Map<string, LoopRow[]>
): LoopRow[] {
  const groupLoops: LoopRow[] = [];
  for (const docId of descendants) {
    const list = loopsByDocumentId.get(docId);
    if (list) {
      groupLoops.push(...list);
    }
  }
  return groupLoops;
}

function buildSummaryFor(
  rootId: string,
  groupLoops: LoopRow[],
  childSubtypeMap: Map<string, ArtifactSubtype | null>
): LoopSummary {
  const active = pickActive(groupLoops);
  const completed = pickLatestCompleted(groupLoops);
  const failed = pickLatestFailed(groupLoops);
  return {
    activeLoop: active ? toEntry(active, rootId, childSubtypeMap) : null,
    latestCompleted: completed
      ? toEntry(completed, rootId, childSubtypeMap)
      : null,
    latestFailed: failed ? toEntry(failed, rootId, childSubtypeMap) : null,
  };
}

async function getSummariesForDocuments(
  organizationId: string,
  documentIds: string[]
): Promise<LoopSummariesResponse> {
  const response: LoopSummariesResponse = {};
  for (const id of documentIds) {
    response[id] = { ...EMPTY_SUMMARY };
  }
  if (documentIds.length === 0) {
    return response;
  }

  const { rootMap, allDescendants } = await collectDescendants(
    organizationId,
    documentIds
  );

  if (allDescendants.size === 0) {
    return response;
  }

  const descendantList = Array.from(allDescendants);
  const [loops, childSubtypeMap] = await Promise.all([
    fetchLoopsForDocuments(organizationId, descendantList),
    fetchChildSubtypes(organizationId, descendantList),
  ]);

  const loopsByDocumentId = groupLoopsByDocument(loops);

  for (const rootId of documentIds) {
    const descendants = rootMap.get(rootId);
    if (!descendants) {
      continue;
    }
    const groupLoops = collectGroupLoops(descendants, loopsByDocumentId);
    if (groupLoops.length === 0) {
      continue;
    }
    response[rootId] = buildSummaryFor(rootId, groupLoops, childSubtypeMap);
  }

  return response;
}

export const loopSummaryService = {
  getSummariesForDocuments,
};
