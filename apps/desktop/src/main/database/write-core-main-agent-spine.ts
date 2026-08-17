/**
 * @file write-core-main-agent-spine.ts
 * @description ISS-4476: the new-session import path's canonical `<sessionId>-main`
 * agent recovery, extracted from `write-core.ts` as its own responsibility (and to
 * keep the grandfathered `write-core.ts` shrinking, not growing).
 *
 * `importPhaseSessionAndMainAgent` (in `write-core.ts`) calls
 * {@link upsertImportedMainAgentSpine} on the branch where `getImportSession`
 * found no `sessions` row. The `sessions` row is provably absent there, but the
 * derived `<sessionId>-main` agent id can still collide with a residual/orphan
 * row — the crash this fix addresses — and a collision does NOT prove the row is
 * this session's main agent. Ownership is verified before any write.
 */
import type { Prisma } from "./generated/client.js";

/** The deterministic id of a session's canonical main agent row. */
export function mainAgentId(sessionId: string): string {
  return `${sessionId}-main`;
}

/**
 * The session-spine read `importPhaseSessionAndMainAgent` branches on: a null
 * result takes the new-session path, a row takes the existing-row reconciliation
 * path. Selects only the columns those branches read.
 */
export function getImportSession(
  tx: Prisma.TransactionClient,
  sessionId: string
) {
  return tx.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      name: true,
      status: true,
      endedAt: true,
      metadata: true,
      dataRevision: true,
      // FEA-4376: needed so a fresh real assistant model id can be detected as a
      // content change when it upgrades a previously-stored `/model` fallback
      // label (which would otherwise be COALESCE-sticky and never re-sync).
      model: true,
    },
  });
}

/**
 * ISS-4476: raised when the derived `<sessionId>-main` agent id collides with an
 * existing row that does NOT belong to this session's canonical main agent. The
 * import fails closed (surfaced as `ImportResult.failed`) rather than reparenting
 * or clobbering another session's row. See {@link upsertImportedMainAgentSpine}.
 */
export class MainAgentIdCollisionError extends Error {
  constructor(mainId: string, sessionId: string, ownerSessionId: string) {
    super(
      `main-agent id "${mainId}" for session "${sessionId}" collides with a row owned by "${ownerSessionId}" (or a non-main row); refusing to reparent`
    );
    this.name = "MainAgentIdCollisionError";
  }
}

export type ImportedMainAgentSpine = {
  mainId: string;
  sessionId: string;
  status: string;
  awaitingSince: string | null;
  // `NormalizedSession.startedAt` is `string | null` at the type level (the
  // importer's up-front guard rejects a null one, but the field type is nullable);
  // the INSERT and the `COALESCE(started_at, …)` recovery both accept null.
  startedAt: string | null;
  now: string;
  endedAt: string | null;
};

/**
 * ISS-4476: insert (or recover) the canonical `<sessionId>-main` agent row on the
 * new-session import path, fail-closed against a mis-owned id collision.
 *
 * The caller reached the new-session branch because `getImportSession` found no
 * `sessions` row, yet the derived `mainId` (`${sessionId}-main`) can already exist
 * as a residual/orphan row (partial import, or a `-main` agent left after its
 * session row was cleared — the ISS-4476 crash). A bare INSERT would throw UNIQUE
 * agents.id and abort the import.
 *
 * An `agents.id` collision does NOT prove the row is this session's main agent:
 * two different session ids can derive the same `${id}-main` string (e.g. a parser
 * subagent id of one session colliding with the main id of another — wongk
 * ISS-4476 review). Reparenting such a row via `ON CONFLICT DO UPDATE SET
 * session_id = excluded.session_id` would silently steal another session's agent
 * (and orphan its events / component invocations under the stolen id). So:
 *   - no colliding row  → plain INSERT (the normal new-session case);
 *   - colliding row is same-session AND `type = 'main'` → legitimate recovery:
 *     rewrite the FULL canonical main-agent shape (name/type/subagent_type/task/
 *     parent/metadata reset, `current_tool` cleared to match the reactivation
 *     path — wongk ISS-4476 review — so a row left mid-tool cannot publish a
 *     waiting/completed status while a stale tool stays visible on the Agent card
 *     and in the sync payload), preserving only the earliest `started_at`;
 *   - anything else (different `session_id`, or not `type = 'main'`) → fail closed
 *     with {@link MainAgentIdCollisionError}: the import returns `failed` and the
 *     collision is neither reparented nor clobbered.
 */
export async function upsertImportedMainAgentSpine(
  tx: Prisma.TransactionClient,
  spine: ImportedMainAgentSpine
): Promise<void> {
  const { mainId, sessionId, status, awaitingSince, startedAt, now, endedAt } =
    spine;
  const collidingRows = await tx.$queryRawUnsafe<
    Array<{ session_id: string; type: string }>
  >("SELECT session_id, type FROM agents WHERE id = $1", mainId);
  const existing = collidingRows[0];
  if (
    existing &&
    (existing.session_id !== sessionId || existing.type !== "main")
  ) {
    // Fail closed: a foreign/non-main row owns this id. Do NOT reparent or
    // clobber it — surface the collision so `importSession` records `failed`
    // instead of silently stealing another session's agent.
    throw new MainAgentIdCollisionError(mainId, sessionId, existing.session_id);
  }
  if (existing) {
    // Legitimate same-session `-main` recovery: restore the canonical shape a
    // fresh insert would write (reset name/type/subagent_type/task/parent/
    // metadata and clear `current_tool`), keeping only the immutable earliest
    // `started_at`.
    await tx.$executeRawUnsafe(
      `UPDATE agents SET
         name = 'main',
         type = 'main',
         subagent_type = NULL,
         status = $1,
         task = NULL,
         current_tool = NULL,
         awaiting_input_since = $2,
         started_at = COALESCE(started_at, $3),
         updated_at = $4,
         ended_at = $5,
         parent_agent_id = NULL,
         metadata = NULL
       WHERE id = $6`,
      status,
      awaitingSince,
      startedAt,
      now,
      endedAt,
      mainId
    );
    return;
  }
  await tx.$executeRawUnsafe(
    `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool, awaiting_input_since, started_at, updated_at, ended_at, parent_agent_id, metadata)
     VALUES ($1, $2, 'main', 'main', NULL, $3, NULL, NULL, $4, $5, $6, $7, NULL, NULL)`,
    mainId,
    sessionId,
    status,
    awaitingSince,
    startedAt,
    now,
    endedAt
  );
}
