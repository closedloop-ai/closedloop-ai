import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { describe, expect, it } from "vitest";
import { SESSION_STATUS_FILTER_OPTIONS } from "../session-status-filters";

describe("SESSION_STATUS_FILTER_OPTIONS", () => {
  it("binds the Failed label to the canonical ERROR value, never the 'failed' literal", () => {
    const failedOption = SESSION_STATUS_FILTER_OPTIONS.find(
      (option) => option.label === "Failed"
    );
    expect(failedOption?.value).toBe(SESSION_STATUS.ERROR);
    expect(failedOption?.value).toBe("error");
  });

  it("only emits canonical SESSION_STATUS values across every option", () => {
    const canonicalValues = new Set<string>(Object.values(SESSION_STATUS));
    for (const option of SESSION_STATUS_FILTER_OPTIONS) {
      expect(canonicalValues.has(option.value)).toBe(true);
    }
  });

  it("never sends the stale 'failed' wire value that matched zero cloud rows", () => {
    expect(
      SESSION_STATUS_FILTER_OPTIONS.some((option) => option.value === "failed")
    ).toBe(false);
  });
});
