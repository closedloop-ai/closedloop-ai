import { describe, expect, it } from "vitest";

import { SESSION_STATUS, type SessionStatus } from "../src/session-status";

/**
 * Pins the canonical session-status string set (FEA-1718 / PLN-921 §8). These
 * exact values are the shared contract between the design-system status badge
 * (which renders a tone per value) and `apps/api` (which writes the value onto
 * a SESSION-typed Artifact's `status` column). Changing a value here is a
 * cross-package contract change and must be deliberate — this test makes an
 * accidental edit fail loudly.
 */
describe("SESSION_STATUS", () => {
  it("exposes exactly the five canonical status values", () => {
    expect(SESSION_STATUS).toEqual({
      ACTIVE: "active",
      WAITING: "waiting",
      COMPLETED: "completed",
      ERROR: "error",
      ABANDONED: "abandoned",
    });
  });

  it("derives SessionStatus from the const values", () => {
    const values: readonly SessionStatus[] = Object.values(SESSION_STATUS);
    expect(new Set(values).size).toBe(Object.keys(SESSION_STATUS).length);
  });
});
