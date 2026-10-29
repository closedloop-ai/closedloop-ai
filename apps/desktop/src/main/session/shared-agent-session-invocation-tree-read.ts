/**
 * @file shared-agent-session-invocation-tree-read.ts
 * @description ISS-10737: the `desktop:shared-agent-sessions:invocation-tree`
 * handler body -- coerce the renderer's request, read one keyset page of the
 * session's raw invocation rows, and map them with the SAME
 * {@link toLocalInvocationReadRow} the component-scoped read uses.
 *
 * MAPPING LIVES HERE, not in the sync source, so the tree and the
 * component-scoped read in `shared-agent-components-api.ts` share one mapper.
 * Neither emits `branchName`.
 *
 * `null` is the ONE fail-closed answer: an unknown session, a source that cannot
 * serve the tree at all, or a cursor this producer could not have minted. So on
 * the desktop a malformed cursor reads as not-found where the cloud answers 400;
 * acceptable because the client only ever replays producer-minted cursors, and
 * refusing to page is the right response to a contract breach. A KNOWN session
 * with no invocations answers a real, empty page with `total: 0` -- that is a
 * measurement, and collapsing it onto `null` would make "this session ran no
 * components" indistinguishable from "this source cannot tell you".
 */

import type { AgentComponentInvocationAncestry } from "@repo/api/src/types/agent-component-invocation-ancestry";
import type {
  AgentComponentInvocationSessionTreePage,
  AgentComponentInvocationSessionTreeRequest,
} from "@repo/api/src/types/agent-component-invocation-session-tree";
import { decodeAgentComponentInvocationSessionTreeCursor } from "@repo/api/src/types/agent-component-invocation-session-tree";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { toLocalInvocationReadRow } from "../dashboard/local-invocation-read.js";
import { coerceNonEmptyString } from "./shared-agent-sessions-query.js";

export async function getSharedAgentSessionInvocationTree(
  source: AgentSessionSyncSource | null | undefined,
  request: Partial<AgentComponentInvocationSessionTreeRequest> &
    Record<string, unknown>
): Promise<AgentComponentInvocationSessionTreePage | null> {
  // `sessionId`, NOT `id`: the wire request is
  // {@link AgentComponentInvocationSessionTreeRequest}, which the renderer's
  // data source and the preload both forward unchanged. The `events` sibling
  // reads `.id` because ITS request type names it that; this one does not, and
  // reading the wrong key here answers `null` for every session, which the
  // renderer maps to a 404 and the Trace tab renders as "could not be loaded".
  const sessionId = coerceNonEmptyString(request.sessionId);
  if (sessionId === null) {
    return null;
  }
  const rawCursor = coerceNonEmptyString(request.cursor);
  const after =
    rawCursor === null
      ? undefined
      : decodeAgentComponentInvocationSessionTreeCursor(rawCursor);
  if (rawCursor !== null && after === null) {
    return null;
  }
  if (!source?.loadSessionInvocationTree) {
    return null;
  }
  // Invoked as a member, never detached: across the db-host boundary `source`
  // is a Proxy that dispatches on the property access itself.
  const read = await source.loadSessionInvocationTree({
    sessionId,
    ...(after === undefined || after === null ? {} : { after }),
  });
  if (!read) {
    return null;
  }
  return {
    items: read.rows.map((row) =>
      toLocalInvocationReadRow(row, SESSION_TREE_NO_ANCESTRY)
    ),
    total: read.total,
    ...(read.nextCursor === undefined ? {} : { nextCursor: read.nextCursor }),
  };
}

/**
 * ISS-10714 x ISS-10737: the SESSION-scoped read does not resolve per-row
 * ancestry. The component-scoped read needs it because a row's ancestors are
 * usually off its page; here the session's own tree IS the page and the client
 * assembles it from `parentExternalInvocationId`, which every row carries.
 * Passed explicitly rather than defaulted so a future caller has to make the
 * same decision out loud.
 */
const SESSION_TREE_NO_ANCESTRY: ReadonlyMap<
  string,
  AgentComponentInvocationAncestry
> = new Map();
