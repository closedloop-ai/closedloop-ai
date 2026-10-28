import { describe, expect, it } from "vitest";
import { SESSION_EVENTS_PAGE_LIMIT_BOUNDS } from "./agent-session-events-page";
import { clampPageLimit } from "./page-limit-bounds";

describe("session events page bounds (ISS-9857)", () => {
  it("serves the default when the caller does not ask", () => {
    expect(clampPageLimit(undefined, SESSION_EVENTS_PAGE_LIMIT_BOUNDS)).toBe(
      SESSION_EVENTS_PAGE_LIMIT_BOUNDS.defaultLimit
    );
  });

  it("clamps both ends and floors a fractional page size", () => {
    expect(clampPageLimit(0, SESSION_EVENTS_PAGE_LIMIT_BOUNDS)).toBe(1);
    expect(clampPageLimit(-5, SESSION_EVENTS_PAGE_LIMIT_BOUNDS)).toBe(1);
    expect(clampPageLimit(2.9, SESSION_EVENTS_PAGE_LIMIT_BOUNDS)).toBe(2);
    expect(clampPageLimit(1_000_000, SESSION_EVENTS_PAGE_LIMIT_BOUNDS)).toBe(
      SESSION_EVENTS_PAGE_LIMIT_BOUNDS.maxLimit
    );
    expect(clampPageLimit(Number.NaN, SESSION_EVENTS_PAGE_LIMIT_BOUNDS)).toBe(
      SESSION_EVENTS_PAGE_LIMIT_BOUNDS.defaultLimit
    );
  });

  it("keeps the default under the ceiling and the ceiling under the detail prefix", () => {
    expect(SESSION_EVENTS_PAGE_LIMIT_BOUNDS.defaultLimit).toBeLessThanOrEqual(
      SESSION_EVENTS_PAGE_LIMIT_BOUNDS.maxLimit
    );
    expect(SESSION_EVENTS_PAGE_LIMIT_BOUNDS.maxLimit).toBeLessThan(10_000);
  });
});
