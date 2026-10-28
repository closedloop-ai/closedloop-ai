import { describe, expect, it, vi } from "vitest";
import { cohortPenseroReaderForRequest } from "./branch-pensero-window";

const capturedWindows: unknown[] = [];

vi.mock("./branch-pensero-numerator", () => ({
  cohortPenseroPointsReader: (
    _identity: unknown,
    _organizationId: string,
    window: unknown
  ) => {
    capturedWindows.push(window);
    return () => Promise.resolve(null);
  },
}));

/**
 * ISS-11117, PR #7863 — the points ratio is WINDOWED to the request rather than
 * withheld from it.
 *
 * Both listings default to `Last7Days`, so the rule this replaced published on
 * the one view nobody lands on (tamsinb, chatgpt-codex-connector). What every
 * case below pins is that a bounded request still gets a reader, and gets it
 * carrying the bounds the delivery fold sums over.
 */
const IDENTITY = { userId: "user-1", clerkUserId: "clerk-1" };
const START = "2026-01-01T00:00:00.000Z";
const END = "2026-01-31T23:59:59.999Z";

describe("cohortPenseroReaderForRequest", () => {
  it("hands the service a reader on a BOUNDED request, carrying its window", () => {
    capturedWindows.length = 0;

    const reader = cohortPenseroReaderForRequest(IDENTITY, "org-1", {
      startDate: START,
      endDate: END,
    });

    // Both halves matter: a reader exists at all (the defect this fixes was its
    // absence on every default view), and it was built with the request's own
    // window rather than the lifetime one.
    expect(typeof reader).toBe("function");
    expect(capturedWindows).toEqual([
      { start: new Date(START), end: new Date(END) },
    ]);
  });

  it("hands the service a reader with NO window on the all-time view", () => {
    capturedWindows.length = 0;

    expect(typeof cohortPenseroReaderForRequest(IDENTITY, "org-1", {})).toBe(
      "function"
    );
    expect(capturedWindows).toEqual([undefined]);
  });
});
