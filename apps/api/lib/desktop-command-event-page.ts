import type { DesktopCommandEvent } from "@repo/api/src/types/compute-target";
import { Prisma, type TransactionClient } from "@repo/database";

/** Rows one sizing probe reads. Bounds the probe, not the answer. */
export const DESKTOP_COMMAND_EVENT_PAGE_SIZE = 500;

/**
 * Largest total `eventPayload` one event read will materialize.
 *
 * A row count is NOT a response bound. Nothing caps a single stored payload —
 * `ingestCommandEvent` writes whatever the gateway frame carried, up to
 * `DESKTOP_GATEWAY_MAX_PAYLOAD_BYTES` (10 MiB) — so 500 max-size `chunk` rows is
 * roughly 5 GiB loaded and serialized on one request, which one authenticated
 * target can ask for on demand (ISS-8547 review). Bytes are the bound that
 * matters.
 */
export const DESKTOP_COMMAND_EVENT_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Second bound, for a history of many tiny events.
 *
 * The byte budget alone would let a million 4-byte payloads run the probe loop
 * for two thousand round trips. Whichever bound is reached first wins.
 */
export const DESKTOP_COMMAND_EVENT_RESPONSE_MAX_ROWS = 5000;

type EventSizeRow = { sequence: number; bytes: number };

/** Receives each event of a command's stream, replayed or live. */
export type EventSubscriber = (event: DesktopCommandEvent) => void;

/**
 * Highest `sequence` one event read may include without exceeding
 * {@link DESKTOP_COMMAND_EVENT_RESPONSE_MAX_BYTES} or
 * {@link DESKTOP_COMMAND_EVENT_RESPONSE_MAX_ROWS}, or `undefined` when nothing
 * is pending after `afterSequence`.
 *
 * Sizes come from `octet_length` rather than from the fetched rows, because
 * measuring rows already in memory would be measuring an allocation that has
 * already happened — which is the whole failure being bounded.
 *
 * The first pending row is ALWAYS included, even when it alone exceeds the byte
 * budget. A read that returned nothing would never advance the caller's cursor,
 * so one oversized event would stall that command's stream permanently instead
 * of costing one large response.
 */
export async function resolveEventReadUpperBound(
  db: TransactionClient,
  commandId: string,
  afterSequence: number | null | undefined
): Promise<number | undefined> {
  let cursor: number | null = afterSequence ?? null;
  let bytes = 0;
  let rows = 0;
  let through: number | undefined;

  while (rows < DESKTOP_COMMAND_EVENT_RESPONSE_MAX_ROWS) {
    const probe = await db.$queryRaw<EventSizeRow[]>(Prisma.sql`
      SELECT sequence, octet_length(event_payload::text)::int AS bytes
      FROM desktop_command_events
      WHERE command_id = ${commandId}::uuid
        AND sequence > COALESCE(${cursor}::int, -1)
      ORDER BY sequence ASC
      LIMIT ${DESKTOP_COMMAND_EVENT_PAGE_SIZE}
    `);
    if (probe.length === 0) {
      return through;
    }
    for (const row of probe) {
      bytes += row.bytes;
      if (
        through !== undefined &&
        bytes > DESKTOP_COMMAND_EVENT_RESPONSE_MAX_BYTES
      ) {
        return through;
      }
      through = row.sequence;
      cursor = row.sequence;
      rows += 1;
      if (rows >= DESKTOP_COMMAND_EVENT_RESPONSE_MAX_ROWS) {
        return through;
      }
    }
    if (probe.length < DESKTOP_COMMAND_EVENT_PAGE_SIZE) {
      return through;
    }
  }
  return through;
}

/**
 * Delivers every event already stored for a command to a freshly-registered
 * subscriber, one page at a time.
 *
 * Paged because `getCommandEvents` returns a byte-bounded page while a replay
 * must still be COMPLETE: it is the only delivery of events published before the
 * subscription, and nothing re-sends them.
 *
 * Terminates because every non-empty page advances the cursor past its last
 * event and the stored history is finite at any instant. Events published while this runs
 * arrive on the already-registered live listener instead, and `liveSequences`
 * keeps them from being delivered twice.
 */
export async function replayBufferedEvents(input: {
  readPage: (
    afterSequence: number | undefined
  ) => Promise<DesktopCommandEvent[] | null>;
  afterSequence: number | undefined;
  liveSequences: ReadonlySet<number>;
  listener: EventSubscriber;
}): Promise<void> {
  let cursor = input.afterSequence;
  let pageSize = 0;
  do {
    const pageStartCursor = cursor;
    const page = (await input.readPage(cursor)) ?? [];
    pageSize = page.length;
    for (const event of page) {
      if (typeof event.sequence === "number") {
        cursor = event.sequence;
        if (input.liveSequences.has(event.sequence)) {
          continue;
        }
      }
      input.listener(event);
    }
    // A full page that advanced nothing would re-read the same rows forever.
    // Unreachable while `sequence` is a non-nullable column, which is exactly
    // why it is a `break` and not a throw: the events were still delivered, so
    // stopping is the honest answer to a shape this function cannot page.
    if (cursor === pageStartCursor) {
      return;
    }
    // Any non-empty page, not a FULL one: `getCommandEvents` now returns a
    // byte-bounded page whose row count varies, so testing it against the row
    // cap would end a replay early and drop the tail — the events nothing
    // re-sends.
  } while (pageSize > 0);
}
