import { describe, expect, it, vi } from "vitest";
import { expectCriticalAxeClean } from "./axe";

const axeRunMock = vi.hoisted(() => vi.fn());
const PRIMARY_ACTION_PATTERN = /primary-action/;
const SECONDARY_ACTION_PATTERN = /secondary-action/;

vi.mock("axe-core", () => ({
  default: {
    run: axeRunMock,
  },
}));

describe("a11y axe helper", () => {
  it("runs WCAG 2.2 AA axe tags", async () => {
    axeRunMock.mockResolvedValueOnce({ violations: [] });

    await expectCriticalAxeClean(document.body);

    expect(axeRunMock).toHaveBeenCalledWith(
      document.body,
      expect.objectContaining({
        runOnly: {
          type: "tag",
          values: [
            "wcag2a",
            "wcag2aa",
            "wcag21a",
            "wcag21aa",
            "wcag22a",
            "wcag22aa",
          ],
        },
      })
    );
  });

  it("requires allowlist entries to match the exact rule and target", async () => {
    axeRunMock.mockResolvedValueOnce({
      violations: [
        {
          id: "color-contrast",
          impact: "critical",
          nodes: [{ target: [".primary-action"] }],
        },
        {
          id: "color-contrast",
          impact: "critical",
          nodes: [{ target: [".secondary-action"] }],
        },
      ],
    });

    await expect(
      expectCriticalAxeClean(document.body, [
        {
          id: "color-contrast",
          reason: "Tracked in FEA-2520 until the primary action token lands.",
          target: ".primary-action",
        },
      ])
    ).rejects.toThrow(SECONDARY_ACTION_PATTERN);
  });

  it("rejects allowlist entries without an owner reason", async () => {
    axeRunMock.mockResolvedValueOnce({
      violations: [
        {
          id: "color-contrast",
          impact: "critical",
          nodes: [{ target: [".primary-action"] }],
        },
      ],
    });

    await expect(
      expectCriticalAxeClean(document.body, [
        {
          id: "color-contrast",
          reason: " ",
          target: ".primary-action",
        },
      ])
    ).rejects.toThrow(PRIMARY_ACTION_PATTERN);
  });
});
