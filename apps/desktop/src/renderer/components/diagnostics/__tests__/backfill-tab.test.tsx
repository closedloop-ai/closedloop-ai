import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BackfillStats } from "../../../../shared/diagnostics-contract";
import { BackfillTab } from "../backfill-tab";

function backfillStats(overrides: Partial<BackfillStats> = {}): BackfillStats {
  return {
    artifactLinks: { totalScanned: 0, lastScannedAt: null },
    prBackfill: { totalScanned: 0, lastScannedAt: null },
    ...overrides,
  };
}

describe("BackfillTab", () => {
  it("renders scanned counts for both backfill lanes", () => {
    render(
      <BackfillTab
        backfill={backfillStats({
          artifactLinks: {
            totalScanned: 42,
            lastScannedAt: "2026-07-29T10:00:00.000Z",
          },
          prBackfill: {
            totalScanned: 7,
            lastScannedAt: "2026-07-28T09:00:00.000Z",
          },
        })}
      />
    );

    expect(screen.getByText("Artifact Link Backfill")).toBeDefined();
    expect(screen.getByText("42")).toBeDefined();
    expect(screen.getByText("2026-07-29T10:00:00.000Z")).toBeDefined();
    expect(screen.getByText("PR Backfill")).toBeDefined();
    expect(screen.getByText("7")).toBeDefined();
    expect(screen.getByText("2026-07-28T09:00:00.000Z")).toBeDefined();
  });

  it("falls back to Never when a lane has not scanned yet", () => {
    render(<BackfillTab backfill={backfillStats()} />);

    const neverLabels = screen.getAllByText("Never");
    expect(neverLabels).toHaveLength(2);
  });
});
