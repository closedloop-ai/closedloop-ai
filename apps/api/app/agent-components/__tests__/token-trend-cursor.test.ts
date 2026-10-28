/**
 * ISS-9851: the token-trend cursor codec and its keyset predicate.
 *
 * `agentSessionId` is a uuid column, so a decoded id that is not uuid-shaped
 * would reach the read as a comparison the database rejects — a 500 for a value
 * a caller supplied. The shape check here is what makes it a 400 instead.
 */

import { describe, expect, it } from "vitest";
import {
  decodeTokenTrendCursor,
  encodeTokenTrendCursor,
  tokenTrendCursorWhere,
} from "../token-trend-cursor";

const STARTED_AT = "2026-07-01T00:00:00.000Z";
const STARTED_MS = Date.parse(STARTED_AT);
const SESSION_ID = "01a08753-c74c-7349-8010-5d07ee4f8bd4";

describe("token-trend cursor codec", () => {
  it("round-trips a session position", () => {
    const cursor = {
      sessionStartedAtMs: STARTED_MS,
      agentSessionId: SESSION_ID,
    };

    expect(decodeTokenTrendCursor(encodeTokenTrendCursor(cursor))).toEqual(
      cursor
    );
  });

  it("refuses an id that is not a session id", () => {
    const token = Buffer.from(`${STARTED_MS}:session-42`, "utf8").toString(
      "base64url"
    );

    expect(decodeTokenTrendCursor(token)).toBeNull();
  });

  it("refuses a token this endpoint did not mint", () => {
    expect(decodeTokenTrendCursor("not-base64url!!")).toBeNull();
    expect(decodeTokenTrendCursor("")).toBeNull();
    expect(
      decodeTokenTrendCursor(
        Buffer.from(SESSION_ID, "utf8").toString("base64url")
      )
    ).toBeNull();
  });
});

describe("token-trend keyset predicate", () => {
  it("asks for the sessions strictly after the cursor's own session", () => {
    const startedAt = new Date(STARTED_MS);

    expect(
      tokenTrendCursorWhere({
        sessionStartedAtMs: STARTED_MS,
        agentSessionId: SESSION_ID,
      })
    ).toEqual({
      OR: [
        // Older sessions…
        { session: { sessionStartedAt: { lt: startedAt } } },
        // …and, at the same instant, only the ones the read had not reached.
        // `gt` and not `gte`: the cursor's own session is already served.
        {
          session: { sessionStartedAt: startedAt },
          agentSessionId: { gt: SESSION_ID },
        },
      ],
    });
  });
});
