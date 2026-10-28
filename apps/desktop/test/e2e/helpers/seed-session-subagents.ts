/**
 * ISS-7144: direct-SQLite seeding of a session's `agents` rows for the desktop
 * E2E suite, so a local detail read projects a SUB-SESSION turn.
 *
 * Its own module rather than another concern piled onto `seed-branches-db.ts`
 * (already well past the file-size smell threshold) or onto
 * `seed-session-timeline-events.ts`, which states that it owns only the `events`
 * row shape. Same split as `seed-activity-segments.ts` (ISS-4896): the shared
 * connection/schema-wait substrate stays in `desktop-seed-core.ts`, and this
 * file owns only the `agents` row shape.
 *
 * ## Why a seeded row, and why it is a real shape
 *
 * `projectAgentSessionTurnItems` (packages/lib/sessions) builds a sub-session
 * turn from `input.agents.filter(isSubagent)` — an agent is a sub-agent when it
 * carries a `subagent_type` or its `type` contains `"subagent"` — and mints it
 * with `_row = input.timeline.length + index`. That ordinal sits past every
 * event-derived row while the turn's INSTANT (`started_at`) can be anywhere in
 * the run, which is the `_row`-vs-time divergence ISS-7115 exists about. The
 * desktop sync source reads these columns verbatim
 * (`selectRowsByIds<SqliteAgentRow>` in `main/database/sync-source.ts`), so a
 * seeded row is indistinguishable from a collected one to the detail read — no
 * test-only code path.
 *
 * The alternative — provoking a sub-agent through the real Claude collector by
 * writing sidechain transcripts — would pin the fixture to the importer's
 * matching heuristics rather than to the projection contract under test.
 */

import {
  applyDesktopSeedPragmas,
  openSeedClient,
  SEED_SCHEMA_TIMEOUT_MS,
  waitForColumnsPresent,
} from "./desktop-seed-core";

const AGENTS_TABLE = "agents";
const AGENT_REQUIRED_COLUMNS = [
  "id",
  "session_id",
  "name",
  "type",
  "subagent_type",
  "status",
  "started_at",
  "updated_at",
  "ended_at",
] as const;

/** `agents.type` for a sub-agent row, matching what the importer writes. */
const SUBAGENT_ROW_TYPE = "subagent";

/**
 * One raw `agents` row for a sub-agent. Mirrors the columns the desktop sync
 * source selects, so the shared detail projection folds it exactly as it folds a
 * collected sub-agent.
 */
export type SessionSubagentSeed = {
  /** `agents.name` — the sub-session's rendered label. */
  name: string;
  /**
   * `agents.subagent_type`. Non-null is what makes `isSubagent` true, which is
   * what mints the `type: "subagent"` turn this seeding exists for.
   */
  subagentType: string;
  /**
   * `agents.started_at`. THE instant the sub-session turn is placed at —
   * `projectAgentSessionTurnItems` takes the first non-null of
   * `startedAt`/`updatedAt`/`endedAt` — while its `_row` comes from the timeline
   * length instead. An instant in the MIDDLE of the run is what makes the two
   * numbering schemes diverge.
   */
  startedAt: string;
  /** `agents.ended_at`; `null` leaves the sub-session open. */
  endedAt?: string | null;
  /** `agents.status`; defaults to `completed`. */
  status?: string;
};

/**
 * Insert sub-agent `agents` rows for an ALREADY-SEEDED session, while the app is
 * DOWN. Compose after `seedSessionsList`.
 *
 * Checkpoints on the way out so the next launch's fresh connection reads the
 * rows from the main db file rather than a WAL segment this process still owns.
 */
export async function seedSessionSubagents(
  userDataDir: string,
  sessionId: string,
  subagents: readonly SessionSubagentSeed[],
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    await waitForColumnsPresent(
      client,
      AGENTS_TABLE,
      AGENT_REQUIRED_COLUMNS,
      options.schemaTimeoutMs ?? SEED_SCHEMA_TIMEOUT_MS
    );
    await client.batch(
      subagents.map((subagent, index) => ({
        sql: `INSERT INTO agents
                (id, session_id, name, type, subagent_type, status,
                 started_at, updated_at, ended_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          `${sessionId}-sub-${index}`,
          sessionId,
          subagent.name,
          SUBAGENT_ROW_TYPE,
          subagent.subagentType,
          subagent.status ?? "completed",
          subagent.startedAt,
          subagent.endedAt ?? subagent.startedAt,
          subagent.endedAt ?? null,
        ],
      })),
      "write"
    );
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}
