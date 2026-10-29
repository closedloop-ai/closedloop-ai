import { describe, expect, it } from "vitest";
import {
  decodeSessionEventCursor,
  encodeSessionEventCursor,
  type SessionEventCursor,
} from "./agent-session-event-cursor";

const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]+$/;

describe("session event cursor codec (ISS-9857)", () => {
  it("round-trips a served position, including a separator inside the id", () => {
    const position = {
      createdAt: "2026-07-10T00:00:04.123Z",
      externalEventId: "toolu_01:with:colons",
    };
    const cursor = encodeSessionEventCursor(position);
    expect(cursor).not.toBeNull();
    expect(decodeSessionEventCursor(cursor)).toEqual(position);
  });

  it("stays URL-safe: no +, / or = in the token", () => {
    const cursor = encodeSessionEventCursor({
      createdAt: "2026-07-10T00:00:04.123Z",
      externalEventId: "évt/+=?",
    });
    expect(cursor).toMatch(BASE64URL_ALPHABET);
    expect(decodeSessionEventCursor(cursor)).toEqual({
      createdAt: "2026-07-10T00:00:04.123Z",
      externalEventId: "évt/+=?",
    });
  });

  it("refuses to mint a cursor from an empty part", () => {
    expect(
      encodeSessionEventCursor({ createdAt: "", externalEventId: "e1" })
    ).toBeNull();
    expect(
      encodeSessionEventCursor({
        createdAt: "2026-07-10T00:00:04.123Z",
        externalEventId: "",
      })
    ).toBeNull();
  });

  it("refuses to mint a cursor from a null timestamp, which the desktop serves at runtime", () => {
    // `events.created_at` is nullable in the desktop store though the row type
    // says `string`; the detail copies it verbatim, and the transcript panel
    // mints a first cursor from every prefix, flag or no flag.
    const untimed = { createdAt: null, externalEventId: "e1" };
    expect(
      encodeSessionEventCursor(untimed as unknown as SessionEventCursor)
    ).toBeNull();
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["blank", ""],
    ["not base64url", "not a cursor!"],
    ["no separator", "bm9zZXA"],
    ["empty timestamp", "OmUx"],
    ["empty id", "MjAyNjo"],
    ["bad percent escape", "JUU6ZTE"],
    // ISS-10436: `%ED%A0%80` is a lone surrogate, which `decodeURIComponent`
    // refuses as malformed UTF-8. This is why the events cursor validator
    // screens externalEventId for NUL only.
    [
      "lone surrogate in the id",
      "MjAyNi0wNy0xMFQwMCUzQTAwJTNBMDQuMTIzWjolRUQlQTAlODA",
    ],
  ])("decodes %s to null", (_label, raw) => {
    expect(decodeSessionEventCursor(raw)).toBeNull();
  });
});
