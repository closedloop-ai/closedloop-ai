import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";
import type { AgentSessionUpsertTx } from "./records";

/**
 * Bind parameters one event row spends in the multi-row INSERT below: the
 * session's artifact id, the external event id, the agent external id, the
 * event type, the tool name, and the event timestamp. `id` costs none — it is
 * supplied inline by `gen_random_uuid()`.
 *
 * Counted off the statement rather than restated beside it, so a seventh column
 * moves the chunk size with it instead of silently overflowing.
 */
export const AGENT_SESSION_EVENT_BIND_PARAMETERS_PER_ROW = 6;

/**
 * Event rows one INSERT may carry — ISS-10168.
 *
 * THE CEILING THIS BOUNDS IS NOT THE ONE ITS SIBLINGS BOUND. ISS-8062 chunked
 * for the Postgres bind-parameter ceiling, where crossing the line gets the
 * statement refused by the driver. This lane died earlier and for a different
 * reason: the flattened values were SPREAD into `$executeRawUnsafe`, so the
 * argument count grew with the event count, and at six per event a 20,000-event
 * session asked for 120,000 arguments — past V8's maximum. That is a
 * synchronous `RangeError` thrown at the call site in ~50 ms, before any
 * database work, whose stack names an argument count rather than anything about
 * sessions or ingest.
 *
 * V8'S ARGUMENT LIMIT IS DELIBERATELY NOT WHAT THIS RESERVES AGAINST, even
 * though it is the ceiling that actually broke. It is not a documented constant
 * — it is whatever the remaining stack at the call site affords, so it moves
 * with call depth, engine version, and `--stack-size`. Measured at the top level
 * on Node 26 it is ~124,000; inside this ingest transaction's own call stack it
 * is lower, which is why the reporting lane saw 120,000 arguments throw. A bound
 * derived from such a number would be a measurement of one stack, not a limit.
 *
 * So the bind ceiling is what gets reserved against, and bounding the
 * PARAMETER count bounds the ARGUMENT count with it — arguments are the
 * parameters plus the one SQL string. The VERBATIM member of the pair, because
 * `$executeRawUnsafe` passes the statement through without Prisma inspecting
 * it, so it meets the wire's uint16 limit rather than Prisma Client's own
 * per-statement budget; the ACCEPTED member, because the question is how wide a
 * statement may be, not the width at which one is refused (ISS-8185's
 * fencepost). Halved for headroom, mirroring
 * `REPO_SYNC_TIER_UPSERT_CHUNK_SIZE` and `OBSERVED_REPOSITORY_UPSERT_CHUNK_SIZE`
 * — the two other verbatim chunkers in this app.
 *
 * That lands at 5,461 rows, so one statement spends at most 32,766 parameters
 * and 32,767 arguments: half the verbatim bind ceiling, and roughly a quarter of
 * the smallest V8 argument limit yet observed on this stack. Both ceilings are
 * cleared by a margin that does not depend on either number being exact, which
 * is the property a bound needs when one of the two cannot be pinned.
 *
 * Floors at 1, like `bindParameterChunkSize` in `write-chunking.ts`, so a row
 * that somehow cost more than the whole halved budget still makes progress one
 * row at a time. Without it the size would be 0, `start += 0` would never
 * advance, and the loop would spin forever emitting an empty `VALUES` list
 * inside the ingest transaction.
 *
 * Chunking is sound here because the statement UNIONS over its rows: a
 * multi-row `VALUES` split across statements inserts the same rows, and every
 * chunk runs inside the caller's interactive transaction, so the write stays
 * all-or-nothing exactly as the single statement was.
 */
export const AGENT_SESSION_EVENT_INSERT_CHUNK_SIZE = Math.max(
  1,
  Math.floor(
    POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS /
      AGENT_SESSION_EVENT_BIND_PARAMETERS_PER_ROW /
      2
  )
);

const INSERT_EVENTS_SQL_PREFIX = `INSERT INTO "agent_session_events" ("id", "agent_session_id", "external_event_id", "agent_external_id", "event_type", "tool_name", "event_created_at") VALUES `;

const INSERT_EVENTS_SQL_SUFFIX = ` ON CONFLICT ("agent_session_id", "external_event_id") DO UPDATE SET "agent_external_id" = EXCLUDED."agent_external_id", "event_type" = EXCLUDED."event_type", "tool_name" = EXCLUDED."tool_name", "event_created_at" = EXCLUDED."event_created_at"`;

/**
 * Batch upsert a session's event rows into the child table.
 *
 * `id` is supplied inline via `gen_random_uuid()`: the Prisma schema's
 * `@default(uuid(7))` is client-side and does not apply to raw SQL, and the
 * column has no DB default — omitting it produces a 23502 null violation on
 * every new event.
 *
 * Org isolation is the caller's, proven once before the transaction opens; see
 * the ownership note on `persistSessionChildren`. These rows are reached only
 * through an `artifactId` that check already bound to the org.
 */
export async function persistSessionEventRows(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  sessionEvents: SyncedAgentSession["events"]
): Promise<void> {
  // Collapse duplicate externalEventIds first: one multi-row
  // `INSERT ... ON CONFLICT DO UPDATE` aborts with SQLSTATE 21000 if it targets
  // the same (agent_session_id, external_event_id) twice, which would roll back
  // the whole session upsert and dead-letter the sync — silently dropping every
  // event for the session (FEA-2690). Deduping before chunking, not per chunk,
  // is load-bearing: two rows sharing an id can land in different chunks, where
  // a per-chunk dedupe would not see them together and the second chunk would
  // overwrite the first's row instead of colliding.
  const events = dedupeEventsByExternalId(sessionEvents);
  for (
    let start = 0;
    start < events.length;
    start += AGENT_SESSION_EVENT_INSERT_CHUNK_SIZE
  ) {
    const chunk = events.slice(
      start,
      start + AGENT_SESSION_EVENT_INSERT_CHUNK_SIZE
    );
    const rowPlaceholders = chunk
      .map((_, index) => {
        const base = index * AGENT_SESSION_EVENT_BIND_PARAMETERS_PER_ROW;
        return `(gen_random_uuid(), $${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::timestamp)`;
      })
      .join(", ");
    await tx.$executeRawUnsafe(
      `${INSERT_EVENTS_SQL_PREFIX}${rowPlaceholders}${INSERT_EVENTS_SQL_SUFFIX}`,
      ...chunk.flatMap((event) => [
        artifactId,
        event.externalEventId,
        event.agentExternalId ?? null,
        event.eventType,
        event.toolName ?? null,
        new Date(event.createdAt),
      ])
    );
  }
}

/**
 * Collapse events that share an `externalEventId` down to a single row (last
 * occurrence wins).
 *
 * The trust boundary permits duplicates: the sync Zod schema does not enforce
 * event-id uniqueness, and the fragment transport concatenates event sets across
 * fragment materializations without dedup, so two rows with the same id can
 * reach the INSERT together. Last-wins mirrors the `DO UPDATE SET ... =
 * EXCLUDED` a re-sync would apply.
 */
function dedupeEventsByExternalId(
  events: SyncedAgentSession["events"]
): SyncedAgentSession["events"] {
  if (events.length < 2) {
    return events;
  }
  const byExternalId = new Map<string, SyncedAgentSession["events"][number]>();
  for (const event of events) {
    byExternalId.set(event.externalEventId, event);
  }
  return byExternalId.size === events.length
    ? events
    : [...byExternalId.values()];
}
