/**
 * @file data-revision-rebuild-test-utils.ts
 * @description Shared probes for the suites that drive the REAL
 * `runDataRevisionRebuild` against a real `openSqliteAgentDatabase`.
 *
 * The same four operations — read the `sessions` projection markers, read the
 * derived event ids, push a session back to an older revision, and re-derive it
 * from one candidate — were hand-rolled per suite, so the SQL that defines
 * "what the rebuild is allowed to change" lived in as many copies as there were
 * files asserting on it. One copy silently drifting is exactly the failure those
 * assertions exist to catch, so the statements live here and the suites bind
 * them to their own session id.
 */

import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import type { openTestDb } from "./agent-db-test-utils.js";
import { fakeCollector } from "./normalized-session-test-utils.js";

export type RebuildTestDb = Awaited<ReturnType<typeof openTestDb>>;

/**
 * The `sessions` columns a rebuild assertion cares about: the two the projection
 * substrate stamps, plus the identity fields that prove WHICH derivation is
 * standing.
 */
export type SessionProjectionMarkerRow = {
  name: string | null;
  cwd: string | null;
  data_revision: number;
  projection_known_good_revision: string | null;
  projection_candidate_revision: string | null;
};

export async function readSessionProjectionMarkers(
  db: RebuildTestDb,
  sessionId: string
): Promise<SessionProjectionMarkerRow | undefined> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    SessionProjectionMarkerRow[]
  >(
    `SELECT name, cwd, data_revision,
            projection_known_good_revision, projection_candidate_revision
       FROM sessions WHERE id = $1`,
    sessionId
  );
  return rows[0];
}

/**
 * The derived events as `id|tool_name` pairs. Carrying the tool name means a
 * teardown that replaced a row's contents while keeping its id still shows up as
 * a difference.
 */
export async function readSessionEventIds(
  db: RebuildTestDb,
  sessionId: string
): Promise<string[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ id: string; tool_name: string | null }>
  >(
    "SELECT id, tool_name FROM events WHERE session_id = $1 ORDER BY id",
    sessionId
  );
  return rows.map((row) => `${row.id}|${row.tool_name ?? ""}`);
}

/** Push a session back to `revision` so the next rebuild pass claims it. */
export async function setSessionDataRevision(
  db: RebuildTestDb,
  sessionId: string,
  revision: number
): Promise<void> {
  await db.run(
    "UPDATE sessions SET data_revision = $1 WHERE id = $2",
    revision,
    sessionId
  );
}

/**
 * Run the production rebuild over a single collector whose parse yields exactly
 * `candidate`, so the test controls the derivation and nothing else about the
 * path is stubbed.
 */
export function rebuildSessionFrom(
  db: RebuildTestDb,
  sessionId: string,
  candidate: NormalizedSession,
  log?: (message: string) => void
) {
  return runDataRevisionRebuild({
    collectors: [
      fakeCollector("claude", {
        sources: [`/fake/${sessionId}.jsonl`],
        parse: () => Promise.resolve([candidate]),
        sessionIdForSource: () => sessionId,
      }),
    ],
    db,
    log,
  });
}
