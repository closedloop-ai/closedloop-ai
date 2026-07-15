import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { describe, expect, it } from "vitest";
import { SESSION_STATUS_FILTER_OPTIONS } from "../session-status-filters";

describe("SESSION_STATUS_FILTER_OPTIONS", () => {
  it("binds the Failed label to the canonical ERROR value, never the 'failed' literal", () => {
    const failedOption = SESSION_STATUS_FILTER_OPTIONS.find(
      (option) => option.label === "Failed"
    );
    expect(failedOption?.value).toBe(SESSION_STATUS.ERROR);
  });

  it("only emits canonical SESSION_STATUS values across every option", () => {
    const canonicalValues = new Set<string>(Object.values(SESSION_STATUS));
    for (const option of SESSION_STATUS_FILTER_OPTIONS) {
      expect(canonicalValues.has(option.value)).toBe(true);
    }
  });

  it("includes active, completed, and abandoned as the primary sessions-page status filters", () => {
    expect(SESSION_STATUS_FILTER_OPTIONS.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        SESSION_STATUS.ACTIVE,
        SESSION_STATUS.COMPLETED,
        SESSION_STATUS.ABANDONED,
      ])
    );
  });

  it("offers Waiting so awaiting-input sessions stay reachable through a status filter", () => {
    const waitingOption = SESSION_STATUS_FILTER_OPTIONS.find(
      (option) => option.value === SESSION_STATUS.WAITING
    );
    expect(waitingOption?.label).toBe("Waiting");
  });

  it("never sends the stale 'failed' wire value that matched zero cloud rows", () => {
    expect(
      SESSION_STATUS_FILTER_OPTIONS.some((option) => option.value === "failed")
    ).toBe(false);
  });
});
