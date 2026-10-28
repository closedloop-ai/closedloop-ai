/**
 * ISS-12251 (PLN-2176 T-6.7): which incoming `createdAt` values the ingest may
 * store. The bounds are the plan's: after 2015-01-01, not after the sync
 * timestamp. Everything else is dropped and reported, never clamped.
 */
import { describe, expect, it } from "vitest";
import { resolveIncomingSessionCreatedAt } from "./session-created-at";

const SYNC_TIMESTAMP = new Date("2026-10-14T12:00:00.000Z");

describe("resolveIncomingSessionCreatedAt (ISS-12251)", () => {
  it("claims nothing for an omitted value", () => {
    expect(resolveIncomingSessionCreatedAt(undefined, SYNC_TIMESTAMP)).toEqual({
      createdAt: null,
      dropped: false,
    });
  });

  it("stores a value after 2015-01-01 up to and including the sync timestamp", () => {
    for (const raw of [
      "2015-01-01T00:00:00.001Z",
      "2026-06-01T09:00:00.000Z",
      SYNC_TIMESTAMP.toISOString(),
    ]) {
      expect(resolveIncomingSessionCreatedAt(raw, SYNC_TIMESTAMP), raw).toEqual(
        { createdAt: new Date(raw), dropped: false }
      );
    }
  });

  it("drops an unparseable, too-early or future value", () => {
    for (const raw of [
      "",
      "not-a-timestamp",
      "1970-01-01T00:00:00.000Z",
      "2015-01-01T00:00:00.000Z",
      "2026-10-14T12:00:00.001Z",
    ]) {
      expect(resolveIncomingSessionCreatedAt(raw, SYNC_TIMESTAMP), raw).toEqual(
        { createdAt: null, dropped: true }
      );
    }
  });
});
