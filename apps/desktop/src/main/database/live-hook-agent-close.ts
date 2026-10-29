/**
 * @file live-hook-agent-close.ts
 * @description ISS-7658 — the ONE way a terminal live hook closes a session's
 * still-running agents, extracted from live-hook.ts so both terminal arms share
 * a single implementation and neither can choose its own subagent status.
 *
 * Pure LEAF: imports only the status constants and the Prisma transaction type,
 * so live-hook.ts imports FROM here one-directionally and there is no cycle.
 */
import { DESKTOP_AGENT_STATUS } from "./db-constants.js";
import type { Prisma } from "./generated/client.js";

/**
 * Close every still-running agent of `sessionId`: the run's own outcome
 * (`mainStatus`) lands on the main spine, every other agent is closed
 * `completed`.
 *
 * The subagent status is FIXED here rather than passed in. `error` puts a closed
 * subagent outside BOTH of `matchSubagent`'s candidate sets (`working` and
 * `completed`), so a late `SubagentStop` resolves to a null agent — losing the
 * event's attribution and, with it, the whole
 * `if (agentId && data.transcript_path)` sidecar-transcript ingest. It also
 * strands the row where only a heal can reach it — and a heal pointed at a
 * source still emitting the bad state never converges, it just re-fixes the same
 * rows every boot. A terminal arm that cannot
 * choose a subagent status cannot reintroduce either failure. This is the same
 * split `sweepStaleChunk` makes when it overrides `type = 'main'` to `error`
 * after closing the swept agents `completed`.
 *
 * Agents already `completed`/`error` are skipped by both statements, so an agent
 * that reported its own outcome keeps that outcome and its own `ended_at`, and a
 * replayed hook re-stamps nothing. That guard covers THESE statements only — a
 * caller's separate main-agent write is not subject to it.
 */
export async function closeNonTerminalAgents(
  tx: Prisma.TransactionClient,
  sessionId: string,
  mainStatus: string,
  now: string
): Promise<void> {
  const stillRunning = `status NOT IN ('${DESKTOP_AGENT_STATUS.COMPLETED}', '${DESKTOP_AGENT_STATUS.ERROR}')`;
  // `type` is nullable, so the non-main arm reads it through COALESCE: a bare
  // `type != 'main'` is NULL for an untyped row, which would leave it closed by
  // neither statement.
  await tx.$executeRawUnsafe(
    `UPDATE agents SET status = '${DESKTOP_AGENT_STATUS.COMPLETED}', ended_at = $1, updated_at = $1 WHERE session_id = $2 AND COALESCE(type, '') != 'main' AND ${stillRunning}`,
    now,
    sessionId
  );
  await tx.$executeRawUnsafe(
    `UPDATE agents SET status = $1, ended_at = $2, updated_at = $2 WHERE session_id = $3 AND type = 'main' AND ${stillRunning}`,
    mainStatus,
    now,
    sessionId
  );
}
