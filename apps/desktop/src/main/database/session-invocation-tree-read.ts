/**
 * @file session-invocation-tree-read.ts
 * @description ISS-10737: one keyset page of ONE local session's agent-component
 * invocations, in canonical session order -- the desktop twin of the cloud's
 * `GET /agent-sessions/[id]/invocation-tree`.
 *
 * WHY NOT `readAgentComponentInvocationPage`. That read is COMPONENT-scoped and
 * capped at `AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS` (500). The Trace tab asks
 * for a session's whole tree, and the reference session behind it carries 516
 * rows -- past that cap. Clipping a tree is not the same as shortening a list:
 * every descendant of a dropped row loses its parent, re-roots at the top level,
 * and reports an ancestry chain that is WRONG rather than short.
 *
 * THE PAGE BOUND IS FOLLOWABLE, not a ceiling. `LIMIT` is pushed into SQL at
 * `AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS + 1`, and the probe row is
 * what mints `nextCursor` -- so a caller reaches the whole population rather
 * than being served a retained prefix (PRD-666).
 *
 * It returns RAW rows: the `branchName` projection needs the cloud-hydrated
 * eligibility snapshot, which lives at the IPC layer, so mapping happens there
 * -- the same split `shared-agent-components-api.ts` already makes. The
 * projection is the shared {@link LOCAL_INVOCATION_READ_COLUMNS}, so this read
 * and the component-scoped one cannot select different columns into one shared
 * row type.
 */

import {
  AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS,
  type AgentComponentInvocationSessionTreeCursor,
  encodeAgentComponentInvocationSessionTreeCursor,
} from "@repo/api/src/types/agent-component-invocation-session-tree";
import {
  LOCAL_INVOCATION_READ_COLUMNS,
  type LocalInvocationReadDbRow,
} from "../dashboard/local-invocation-read.js";
import { numberOrZero as toNumber } from "./db-helpers.js";
import type { DesktopPrisma } from "./prisma-client.js";

export type SessionInvocationTreeRequest = {
  sessionId: string;
  /** Keyset position to page strictly AFTER; absent reads the head. */
  after?: AgentComponentInvocationSessionTreeCursor;
};

export type SessionInvocationTreeRows = {
  rows: LocalInvocationReadDbRow[];
  /** Counted on the same predicate as the rows, independently of the page. */
  total: number;
  /** Omitted at exhaustion; never null. */
  nextCursor?: string;
};

/**
 * `null` when no `sessions` row carries `sessionId` -- the same fail-closed
 * answer the detail and event-page reads give, so an unknown id and a disabled
 * runtime both read as not-found rather than as a session with no invocations.
 * A KNOWN session with no invocation rows answers `{ rows: [], total: 0 }`,
 * which is a real measurement and must not be collapsed onto `null`.
 */
export async function readSessionInvocationTree(
  prisma: DesktopPrisma,
  input: SessionInvocationTreeRequest
): Promise<SessionInvocationTreeRows | null> {
  return await prisma.read(async (reader) => {
    const sessionRows = await reader.$queryRawUnsafe<{ id: string }[]>(
      "SELECT id FROM sessions WHERE id = $1 LIMIT 1",
      input.sessionId
    );
    if (sessionRows.length === 0) {
      return null;
    }
    const after = input.after;
    const keyset =
      after === undefined
        ? { clause: "", params: [] as unknown[] }
        : {
            clause: `AND (sequence > $3
                    OR (sequence = $3 AND external_invocation_id > $4)
                    OR (sequence = $3 AND external_invocation_id = $4 AND id > $5))`,
            params: [after.sequence, after.externalInvocationId, after.id],
          };
    const [windowRows, countRows] = await Promise.all([
      reader.$queryRawUnsafe<LocalInvocationReadDbRow[]>(
        `SELECT ${LOCAL_INVOCATION_READ_COLUMNS}
           FROM agent_component_invocations
          WHERE session_id = $1 ${keyset.clause}
          ORDER BY sequence ASC, external_invocation_id ASC, id ASC
          LIMIT $2`,
        input.sessionId,
        AGENT_COMPONENT_INVOCATION_SESSION_TREE_PAGE_ROWS + 1,
        ...keyset.params
      ),
      reader.$queryRawUnsafe<{ total: bigint | number | null }[]>(
        `SELECT COUNT(*) AS total
           FROM agent_component_invocations
          WHERE session_id = $1`,
        input.sessionId
      ),
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
            sequence: toNumber(lastOnPage.sequence),
            externalInvocationId: lastOnPage.external_invocation_id,
            id: lastOnPage.id,
          })
        : null;
    return {
      rows,
      total: toNumber(countRows[0]?.total),
      ...(nextCursor === null ? {} : { nextCursor }),
    };
  });
}

/** The `loadSessionInvocationTree` member of the SQLite sync source. */
export function createSessionInvocationTreeReader(prisma: DesktopPrisma): {
  loadSessionInvocationTree: (
    input: SessionInvocationTreeRequest
  ) => Promise<SessionInvocationTreeRows | null>;
} {
  return {
    loadSessionInvocationTree: (input: SessionInvocationTreeRequest) =>
      readSessionInvocationTree(prisma, input),
  };
}
