import { describe, expect, it } from "vitest";
import {
  createNormalizedSession,
  deriveEndedOnUnrecoveredError,
} from "./types";

const ASSISTANT_EARLY = "2026-07-01T12:00:00.000Z";
const ASSISTANT_LATE = "2026-07-01T12:10:00.000Z";
const ERROR_MID = "2026-07-01T12:05:00.000Z";
const ERROR_LATE = "2026-07-01T12:15:00.000Z";

describe("deriveEndedOnUnrecoveredError (FEA-4187)", () => {
  it("returns false for a run with no API errors", () => {
    const session = createNormalizedSession({
      sessionId: "s1",
      messages: [{ role: "assistant", timestamp: ASSISTANT_EARLY, text: "ok" }],
    });
    expect(deriveEndedOnUnrecoveredError(session)).toBe(false);
  });

  it("returns true when the last error is after the last assistant message", () => {
    const session = createNormalizedSession({
      sessionId: "s2",
      messages: [{ role: "assistant", timestamp: ASSISTANT_EARLY, text: "ok" }],
      apiErrors: [
        { type: "overloaded_error", message: "boom", timestamp: ERROR_LATE },
      ],
    });
    expect(deriveEndedOnUnrecoveredError(session)).toBe(true);
  });

  it("returns true when the last error equals the last assistant timestamp (>= edge)", () => {
    const session = createNormalizedSession({
      sessionId: "s3",
      messages: [{ role: "assistant", timestamp: ERROR_MID, text: "ok" }],
      apiErrors: [
        { type: "rate_limit", message: "boom", timestamp: ERROR_MID },
      ],
    });
    expect(deriveEndedOnUnrecoveredError(session)).toBe(true);
  });

  it("returns false when a later assistant message recovered after the error", () => {
    const session = createNormalizedSession({
      sessionId: "s4",
      messages: [
        { role: "assistant", timestamp: ASSISTANT_EARLY, text: "before" },
        { role: "assistant", timestamp: ASSISTANT_LATE, text: "recovered" },
      ],
      apiErrors: [
        { type: "overloaded_error", message: "boom", timestamp: ERROR_MID },
      ],
    });
    expect(deriveEndedOnUnrecoveredError(session)).toBe(false);
  });

  it("returns true when an error exists but there is no assistant message at all", () => {
    const session = createNormalizedSession({
      sessionId: "s5",
      messages: [{ role: "human", timestamp: ASSISTANT_EARLY, text: "hi" }],
      apiErrors: [
        { type: "overloaded_error", message: "boom", timestamp: ERROR_MID },
      ],
    });
    expect(deriveEndedOnUnrecoveredError(session)).toBe(true);
  });

  it("ignores an error whose timestamp is null (contributes no failure signal)", () => {
    const session = createNormalizedSession({
      sessionId: "s6",
      messages: [{ role: "assistant", timestamp: ASSISTANT_EARLY, text: "ok" }],
      apiErrors: [
        { type: "overloaded_error", message: "boom", timestamp: null },
      ],
    });
    expect(deriveEndedOnUnrecoveredError(session)).toBe(false);
  });

  it("scans the max error timestamp, not the last array element (survives reordering/truncation)", () => {
    // A trailing error can appear before an earlier one in the array; the derivation
    // must use the maximum timestamp, not the last element.
    const session = createNormalizedSession({
      sessionId: "s7",
      messages: [{ role: "assistant", timestamp: ASSISTANT_LATE, text: "ok" }],
      apiErrors: [
        { type: "e", message: "later", timestamp: ERROR_LATE },
        { type: "e", message: "earlier", timestamp: ERROR_MID },
      ],
    });
    expect(deriveEndedOnUnrecoveredError(session)).toBe(true);
  });
});
