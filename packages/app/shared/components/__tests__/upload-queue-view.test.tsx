import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type UploadQueueCounts, UploadQueueView } from "../upload-queue-view";

/**
 * ISS-12529. Every string here is a test fixture, not product copy: the
 * component takes all its text from its host.
 */
const COPY = {
  heading: "fixture-heading",
  queuedLabel: "fixture-queued",
  inFlightLabel: "fixture-in-flight",
  failedLabel: "fixture-failed",
  emptyText: "fixture-empty",
  unmeasuredText: "fixture-unmeasured",
} as const;

function renderView(counts: UploadQueueCounts | null) {
  return render(<UploadQueueView copy={COPY} counts={counts} />);
}

describe("UploadQueueView", () => {
  it("lists queued, in-flight and failed with their counts (AC-001)", () => {
    renderView({ queued: 1204, inFlight: 3, failed: 0 });
    const list = screen.getByRole("list", { name: COPY.heading });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      `${COPY.queuedLabel}${(1204).toLocaleString()}`,
      `${COPY.inFlightLabel}3`,
      `${COPY.failedLabel}0`,
    ]);
    expect(screen.queryByText(COPY.emptyText)).toBeNull();
  });

  it("renders the empty state when nothing is queued, in flight or failed (AC-002)", () => {
    renderView({ queued: 0, inFlight: 0, failed: 0 });
    expect(screen.getByText(COPY.emptyText)).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByTestId("upload-queue-view")).toHaveAttribute(
      "data-state",
      "empty"
    );
  });

  it("keeps the list when only failures remain, so a failure is never hidden", () => {
    renderView({ queued: 0, inFlight: 0, failed: 2 });
    expect(screen.queryByText(COPY.emptyText)).toBeNull();
    expect(
      screen.getByTestId("upload-queue-view-row-failed")
    ).toHaveTextContent(`${COPY.failedLabel}2`);
  });

  it("never renders the empty state for an unmeasured queue", () => {
    renderView(null);
    expect(screen.getByText(COPY.unmeasuredText)).toBeVisible();
    expect(screen.queryByText(COPY.emptyText)).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
