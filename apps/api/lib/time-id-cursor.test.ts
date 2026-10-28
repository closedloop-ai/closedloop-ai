/**
 * The shared `(timestamp, id)` keyset codec. A cursor is a token the server
 * minted and a client replayed, so every case here is about what happens when
 * what comes back is NOT that token: the decode is the boundary where a bad
 * value becomes `null` instead of a query predicate.
 */

import { describe, expect, it } from "vitest";
import { decodeTimeIdCursor, encodeTimeIdCursor } from "./time-id-cursor";

const MS = Date.parse("2026-07-01T00:00:00.000Z");
const ID = "01a08753-c74c-7349-8010-5d07ee4f8bd4";

function tokenFor(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}

describe("time-id cursor", () => {
  it("round-trips the position it encoded", () => {
    expect(decodeTimeIdCursor(encodeTimeIdCursor(MS, ID))).toEqual({
      ms: MS,
      id: ID,
    });
  });

  it("keeps an id containing the separator whole", () => {
    // The id is everything after the FIRST colon: a source-qualified feed id
    // (`version:abc`) must not be truncated at its own separator.
    const qualified = "version:abc:def";

    expect(decodeTimeIdCursor(encodeTimeIdCursor(MS, qualified))?.id).toBe(
      qualified
    );
  });

  it("reads nothing from an absent cursor", () => {
    expect(decodeTimeIdCursor(undefined)).toBeNull();
    expect(decodeTimeIdCursor(null)).toBeNull();
    expect(decodeTimeIdCursor("")).toBeNull();
  });

  it("refuses a token with no separator", () => {
    expect(decodeTimeIdCursor(tokenFor("1789081658047"))).toBeNull();
  });

  it("refuses a token with no id", () => {
    expect(decodeTimeIdCursor(tokenFor(`${MS}:`))).toBeNull();
  });

  it("refuses a blank timestamp instead of reading it as the epoch", () => {
    // `Number("")` is 0, which is a real instant. A token that names no time
    // must not decode to one.
    expect(decodeTimeIdCursor(tokenFor(`:${ID}`))).toBeNull();
  });

  it("refuses a timestamp that is not written as an integer", () => {
    // `Number` accepts all of these; none is a timestamp this codec emitted.
    expect(decodeTimeIdCursor(tokenFor(`1e3:${ID}`))).toBeNull();
    expect(decodeTimeIdCursor(tokenFor(`1.5:${ID}`))).toBeNull();
    expect(decodeTimeIdCursor(tokenFor(` 12:${ID}`))).toBeNull();
    expect(decodeTimeIdCursor(tokenFor(`0x10:${ID}`))).toBeNull();
  });

  it("refuses a timestamp outside the representable date range", () => {
    expect(decodeTimeIdCursor(tokenFor(`8640000000000001:${ID}`))).toBeNull();
    expect(decodeTimeIdCursor(tokenFor(`-8640000000000001:${ID}`))).toBeNull();
    // The exact edge is still a date, so it still decodes.
    expect(decodeTimeIdCursor(tokenFor(`8640000000000000:${ID}`))).toEqual({
      ms: 8_640_000_000_000_000,
      id: ID,
    });
  });

  it("refuses an id the caller's own predicate rejects", () => {
    const token = encodeTimeIdCursor(MS, "not-a-uuid");

    expect(decodeTimeIdCursor(token, (id) => id === ID)).toBeNull();
    expect(decodeTimeIdCursor(token)).toEqual({ ms: MS, id: "not-a-uuid" });
  });
});
