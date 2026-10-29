import { describe, expect, it } from "vitest";
import {
  isSessionEventsRepeatedCursor,
  nextSessionEventsPageParam,
  SessionEventsCursorLoopError,
} from "../session-events-pages";

describe("nextSessionEventsPageParam (ISS-9857)", () => {
  it("ends the walk when the page offers no cursor", () => {
    expect(nextSessionEventsPageParam({ events: [] }, [{ cursor: "c1" }])).toBe(
      undefined
    );
  });

  it("requests the offered cursor when the walk has not asked for it", () => {
    expect(
      nextSessionEventsPageParam({ events: [], nextCursor: "c2" }, [
        { cursor: "c1" },
      ])
    ).toEqual({ cursor: "c2" });
  });

  it("refuses a cursor the walk already asked for — the first one included", () => {
    const refusal = nextSessionEventsPageParam(
      { events: [], nextCursor: "c1" },
      [{ cursor: "c1" }, { cursor: "c2" }]
    );
    expect(refusal).toEqual({ repeatedCursor: "c1" });
    expect(refusal && isSessionEventsRepeatedCursor(refusal)).toBe(true);
    expect(isSessionEventsRepeatedCursor({ cursor: "c1" })).toBe(false);
  });

  it("names the loop error so the query can decline to retry it", () => {
    expect(new SessionEventsCursorLoopError().name).toBe(
      "SessionEventsCursorLoopError"
    );
  });
});
