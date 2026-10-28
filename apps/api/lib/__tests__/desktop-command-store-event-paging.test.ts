import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-8547 Section 5: `getCommandEvents` read a command's WHOLE event history in
 * one response, each row's `eventPayload` bounded only by the 10 MiB gateway
 * frame limit.
 *
 * Review moved the bound from rows to BYTES: nothing caps a single stored
 * payload, so a 500-row cap still admitted roughly 5 GiB on one request. The
 * read now resolves how far it can go from `octet_length` before fetching any
 * payload, and pages FORWARD across probes so a chatty command's cursor can
 * catch up within one poll instead of advancing 500 events per tick.
 *
 * These drive the store against a fake Prisma that honours the cursor and the
 * limit on the sizing probe AND `sequence.gt` / `sequence.lte` on the fetch, so
 * removing either bound changes what the cases observe.
 */

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  // The sizing probe is a tagged template; capturing the interpolated values is
  // what lets the fake below model the cursor and the limit.
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  DESKTOP_COMMAND_EVENT_RESPONSE_MAX_BYTES,
  DESKTOP_COMMAND_EVENT_RESPONSE_MAX_ROWS,
} from "@/lib/desktop-command-event-page";
import { desktopCommandStore } from "@/lib/desktop-command-store";

const TARGET_ID = "target-1";
const COMMAND_ID = "11111111-1111-7111-8111-111111111111";
const CREATED_AT = new Date("2026-08-31T00:00:00.000Z");

type EventRow = {
  commandId: string;
  sequence: number;
  eventType: string;
  eventPayload: unknown;
  createdAt: Date;
};

function rowsWithPayload(count: number, payload: unknown): EventRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    commandId: COMMAND_ID,
    sequence: index + 1,
    eventType: "chunk",
    eventPayload: payload,
    createdAt: CREATED_AT,
  }));
}

function payloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

type ProbeQuery = { values: unknown[] };

/**
 * A fake whose sizing probe applies the cursor and the limit it was given, and
 * whose fetch applies both `sequence` bounds. `probeCount` records how many
 * probes the store issued, which is how the forward-drain cases tell one probe
 * from several.
 */
function installFakeDb(rows: EventRow[]): { probeCount: () => number } {
  let probes = 0;
  const db = {
    desktopCommand: {
      findFirst: vi.fn().mockResolvedValue({
        id: COMMAND_ID,
        computeTargetId: TARGET_ID,
        operationId: "git_action",
        idempotencyKey: null,
        requestFingerprint: "fingerprint",
        requestPayload: {
          method: "POST",
          path: "/api/gateway/git",
          headers: {},
          body: null,
        },
        status: "running",
        error: null,
        lastSequenceAcked: 0,
        createdAt: CREATED_AT,
        startedAt: null,
        finishedAt: null,
      }),
    },
    $queryRaw: vi.fn((query: ProbeQuery) => {
      probes += 1;
      const cursor = query.values[1] as number | null;
      const limit = query.values[2] as number;
      const after = cursor === null ? -1 : cursor;
      return Promise.resolve(
        rows
          .filter((row) => row.sequence > after)
          .slice(0, limit)
          .map((row) => ({
            sequence: row.sequence,
            bytes: payloadBytes(row.eventPayload),
          }))
      );
    }),
    desktopCommandEvent: {
      findMany: vi.fn(
        (args: { where?: { sequence?: { gt?: number; lte?: number } } }) => {
          const gt = args.where?.sequence?.gt;
          const lte = args.where?.sequence?.lte;
          return Promise.resolve(
            rows.filter(
              (row) =>
                (gt === undefined || row.sequence > gt) &&
                (lte === undefined || row.sequence <= lte)
            )
          );
        }
      ),
    },
  };
  mocks.withDb.mockImplementation((run: (client: unknown) => unknown) =>
    Promise.resolve(run(db))
  );
  return { probeCount: () => probes };
}

describe("desktopCommandStore.getCommandEvents — byte bound (ISS-8547)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops at the byte budget, not at a row count", async () => {
    // 64 KiB apiece, so the budget bites long before any row cap would.
    const payload = "x".repeat(64 * 1024);
    const rowBytes = payloadBytes(payload);
    const affordable = Math.floor(
      DESKTOP_COMMAND_EVENT_RESPONSE_MAX_BYTES / rowBytes
    );
    installFakeDb(rowsWithPayload(affordable + 10, payload));

    const events = await desktopCommandStore.getCommandEvents(
      TARGET_ID,
      COMMAND_ID
    );

    expect(events).toHaveLength(affordable);
    expect(events?.at(-1)?.sequence).toBe(affordable);
  });

  it("delivers the remainder from the cursor, so the budget pages rather than truncates", async () => {
    const payload = "x".repeat(64 * 1024);
    const rowBytes = payloadBytes(payload);
    const affordable = Math.floor(
      DESKTOP_COMMAND_EVENT_RESPONSE_MAX_BYTES / rowBytes
    );
    installFakeDb(rowsWithPayload(affordable + 3, payload));

    const remainder = await desktopCommandStore.getCommandEvents(
      TARGET_ID,
      COMMAND_ID,
      { afterSequence: affordable }
    );

    expect(remainder?.map((event) => event.sequence)).toEqual([
      affordable + 1,
      affordable + 2,
      affordable + 3,
    ]);
  });

  it("still delivers one event that alone exceeds the budget, so a stream cannot stall", async () => {
    const oversized = "x".repeat(DESKTOP_COMMAND_EVENT_RESPONSE_MAX_BYTES + 16);
    installFakeDb(rowsWithPayload(3, oversized));

    const events = await desktopCommandStore.getCommandEvents(
      TARGET_ID,
      COMMAND_ID
    );

    // Exactly one: enough for the caller's cursor to advance past it, and never
    // zero, which would re-read the same oversized row on every poll forever.
    expect(events?.map((event) => event.sequence)).toEqual([1]);
  });

  it("bounds a history of tiny events by rows once bytes cannot bite", async () => {
    installFakeDb(
      rowsWithPayload(DESKTOP_COMMAND_EVENT_RESPONSE_MAX_ROWS + 25, { a: 1 })
    );

    const events = await desktopCommandStore.getCommandEvents(
      TARGET_ID,
      COMMAND_ID
    );

    expect(events).toHaveLength(DESKTOP_COMMAND_EVENT_RESPONSE_MAX_ROWS);
  });

  it("reads FORWARD past one probe, so a chatty command's cursor catches up", async () => {
    // 1200 small events span three 500-row probes. Under the old row cap this
    // answered 500 and the two polling consumers (1s and 2s ticks) could never
    // catch up on a command emitting a `chunk` per gateway NDJSON line.
    const { probeCount } = installFakeDb(rowsWithPayload(1200, { a: 1 }));

    const events = await desktopCommandStore.getCommandEvents(
      TARGET_ID,
      COMMAND_ID
    );

    expect(events).toHaveLength(1200);
    expect(probeCount()).toBeGreaterThan(1);
  });

  it("returns every event unchanged for a command well under both bounds", async () => {
    installFakeDb(rowsWithPayload(3, { a: 1 }));

    const events = await desktopCommandStore.getCommandEvents(
      TARGET_ID,
      COMMAND_ID
    );

    expect(events?.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("replays EVERY buffered event to a subscriber, paging past the bounds", async () => {
    // A subscriber's replay is the only delivery of events published before it
    // subscribed — nothing re-sends them — so the bounds must not truncate it.
    const payload = "x".repeat(64 * 1024);
    const rowBytes = payloadBytes(payload);
    const total =
      Math.floor(DESKTOP_COMMAND_EVENT_RESPONSE_MAX_BYTES / rowBytes) + 7;
    installFakeDb(rowsWithPayload(total, payload));
    const received: number[] = [];

    const unsubscribe = await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      COMMAND_ID,
      (event) => {
        if (typeof event.sequence === "number") {
          received.push(event.sequence);
        }
      },
      { replay: true }
    );

    expect(received).toHaveLength(total);
    expect(received.at(-1)).toBe(total);
    unsubscribe?.();
  });

  it("still answers null for a command the target does not own", async () => {
    installFakeDb(rowsWithPayload(5, { a: 1 }));
    mocks.withDb.mockImplementationOnce(() => Promise.resolve(null));

    const events = await desktopCommandStore.getCommandEvents(
      TARGET_ID,
      COMMAND_ID
    );

    expect(events).toBeNull();
  });
});
