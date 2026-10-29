import "server-only";

import type { AgentComponentInvocationAncestry } from "@repo/api/src/types/agent-component-invocation-ancestry";
import type {
  AgentComponentInvocationSessionTreePage,
  AgentComponentInvocationSessionTreeRequest,
} from "@repo/api/src/types/agent-component-invocation-session-tree";
import {
  AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS,
  decodeAgentComponentInvocationSessionTreeCursor,
  encodeAgentComponentInvocationSessionTreeCursor,
} from "@repo/api/src/types/agent-component-invocation-session-tree";
import type { Prisma, withDb } from "@repo/database";
import {
  INVOCATION_READ_SELECT,
  INVOCATION_SOURCE_OCCURRENCE_SELECT,
  toInvocationReadRow,
} from "@/app/agent-components/service/invocation-read";

type SessionInvocationTreeInput = AgentComponentInvocationSessionTreeRequest & {
  organizationId: string;
};

/**
 * ISS-10737: one keyset page of ONE session's invocations, ordered so the whole
 * tree can be assembled from the walk.
 *
 * ORG SCOPE IS THE BOUNDARY, exactly as it is on the component-scoped read: the
 * invocation table carries no `organization_id` of its own, so the scope arrives
 * through `generation.session.artifact.organizationId`. A session in another
 * organization matches nothing and the caller is answered `undefined`, which the
 * route turns into a 404 rather than an empty tree -- an empty tree is a claim
 * about the session, and this read has not established that it may make one.
 *
 * ONE SCOPE READ PER REQUEST (AGENTS.md -> Query Shape). Two statements run and
 * both are aggregate: the bounded page read, and one `count` on the SAME
 * unbounded predicate. Neither is per-row and neither walks the tree -- the tree
 * is assembled in the client from `parentExternalInvocationId`, which every row
 * already carries, so there is no N+1 over ancestry.
 *
 * ORDER IS `sequence`, NOT `invokedAt DESC`. The component read orders newest
 * first because it renders a list; a tree needs canonical session order so the
 * page boundary falls between rows rather than through an arbitrary interior
 * slice. Rows with no `invokedAt` are still returned: they are unplaceable on a
 * time axis, not absent from the session.
 *
 * THE PAGE BOUND IS FOLLOWABLE. `nextCursor` is minted from the last row served
 * and only when a probe row proved there is more, so a caller reaches the whole
 * population instead of being handed a retained prefix (PRD-666).
 */
export async function loadAgentSessionInvocationTree(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  input: SessionInvocationTreeInput
): Promise<AgentComponentInvocationSessionTreePage | undefined> {
  // The session artifact is `SessionDetail`, keyed by `artifactId`; its org
  // lives on the `artifact` relation, which is also the route the invocation
  // predicate below takes to the same scope.
  const session = await db.sessionDetail.findFirst({
    where: {
      artifactId: input.sessionId,
      artifact: { organizationId: input.organizationId },
    },
    select: { artifactId: true },
  });
  if (!session) {
    return undefined;
  }
  const cursor = resolveSessionTreeCursor(input.cursor);
  const where = sessionInvocationTreeWhere(input);
  const pageWhere =
    cursor === null ? where : { AND: [where, sessionTreeCursorWhere(cursor)] };
  const [windowRows, total] = await Promise.all([
    db.agentComponentInvocation.findMany({
      where: pageWhere,
      select: INVOCATION_READ_SELECT,
      orderBy: [
        { sequence: "asc" },
        { externalInvocationId: "asc" },
        { id: "asc" },
      ],
      // One row past the page, so exhaustion is decided by this page's own
      // result rather than by comparing against a separately-read count.
      take: AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS + 1,
    }),
    db.agentComponentInvocation.count({ where }),
  ]);
  const hasMore =
    windowRows.length > AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS;
  const rows = hasMore
    ? windowRows.slice(0, AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS)
    : windowRows;
  const lastOnPage = rows.at(-1);
  const nextCursor =
    hasMore && lastOnPage
      ? encodeAgentComponentInvocationSessionTreeCursor({
          sequence: lastOnPage.sequence,
          externalInvocationId: lastOnPage.externalInvocationId,
          id: lastOnPage.id,
        })
      : null;
  const sourceOccurrenceIds = Array.from(
    new Set(
      rows.flatMap((row) =>
        row.sourceOccurrenceId === null ? [] : [row.sourceOccurrenceId]
      )
    )
  );
  const sourceOccurrences =
    sourceOccurrenceIds.length === 0
      ? []
      : await db.sourceOccurrence.findMany({
          where: {
            organizationId: input.organizationId,
            id: { in: sourceOccurrenceIds },
          },
          select: INVOCATION_SOURCE_OCCURRENCE_SELECT,
        });
  const sourceOccurrenceById = new Map(
    sourceOccurrences.map((occurrence) => [occurrence.id, occurrence])
  );
  return {
    items: rows.map((row) =>
      toInvocationReadRow(row, sourceOccurrenceById, SESSION_TREE_NO_ANCESTRY)
    ),
    total,
    ...(nextCursor === null ? {} : { nextCursor }),
  };
}

/**
 * ISS-10714 x ISS-10737: this read does NOT resolve per-row ancestry chains.
 * The component-scoped read needs them because its page is scoped by component,
 * so a row's ancestors are usually off the page; here the whole session's tree
 * is the page's own content and the client assembles it from
 * `parentExternalInvocationId`, which every row already carries. Resolving the
 * chains anyway would add the per-hop reads this function's contract above
 * explicitly refuses. Passed explicitly rather than defaulted so a future caller
 * has to make the same decision out loud.
 */
const SESSION_TREE_NO_ANCESTRY: ReadonlyMap<
  string,
  AgentComponentInvocationAncestry
> = new Map();

function sessionInvocationTreeWhere(
  input: SessionInvocationTreeInput
): Prisma.AgentComponentInvocationWhereInput {
  return {
    generation: {
      agentSessionId: input.sessionId,
      activeAt: { not: null },
      completedAt: { not: null },
      session: { artifact: { organizationId: input.organizationId } },
    },
  };
}

/** Strictly after the keyset position, in this read's own `(sequence, externalInvocationId, id)` order. */
function sessionTreeCursorWhere(cursor: {
  sequence: number;
  externalInvocationId: string;
  id: string;
}): Prisma.AgentComponentInvocationWhereInput {
  return {
    OR: [
      { sequence: { gt: cursor.sequence } },
      {
        sequence: cursor.sequence,
        externalInvocationId: { gt: cursor.externalInvocationId },
      },
      {
        sequence: cursor.sequence,
        externalInvocationId: cursor.externalInvocationId,
        id: { gt: cursor.id },
      },
    ],
  };
}

/**
 * A cursor this read minted, or `null` for no cursor at all. A token that does
 * not decode THROWS rather than falling back to the head: a walking caller
 * silently restarted at row 1 never terminates. An EMPTY STRING is a malformed
 * token and throws with the rest of them -- `?cursor=` is exactly what a query
 * parameter produces.
 */
function resolveSessionTreeCursor(raw: string | null | undefined) {
  if (raw === null || raw === undefined) {
    return null;
  }
  const cursor = decodeAgentComponentInvocationSessionTreeCursor(raw);
  if (cursor === null) {
    throw new Error("Invalid session invocation tree cursor");
  }
  return cursor;
}
