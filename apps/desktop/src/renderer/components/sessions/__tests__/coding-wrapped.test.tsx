import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodingWrapped } from "../coding-wrapped";
import { makeGroundedMetrics } from "./grounded-metrics-factory";

const LAST_N_DAYS_PATTERN = /last \d+ days/;

describe("CodingWrapped", () => {
  it("renders nothing when metrics are null", () => {
    const { container } = render(<CodingWrapped metrics={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no fun-fact signal is present", () => {
    const { container } = render(
      <CodingWrapped metrics={makeGroundedMetrics({})} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a labelled deck with a card per available signal", () => {
    render(
      <CodingWrapped
        metrics={makeGroundedMetrics({
          lookbackDays: 14,
          modelMix: [
            { model: "claude-opus-4", sessions: 5, share: 0.9, tokens: 90 },
          ],
          planModeRatio: 0.5,
        })}
      />
    );
    expect(screen.getByLabelText("Coding Wrapped")).toBeTruthy();
    expect(screen.getByText("last 14 days")).toBeTruthy();
    expect(screen.getByText("claude-opus-4")).toBeTruthy();
    expect(screen.getByText("Top model")).toBeTruthy();
    expect(screen.getByText("Plan mode")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
  });

  it("labels the all-time range (lookbackDays 0 sentinel) as 'all time'", () => {
    // FEA-3722: the "All" date range windows analytics unbounded and reports a
    // lookbackDays of 0; the header must read "all time", not be hidden (which
    // previously masked which range the deck reflected).
    render(
      <CodingWrapped
        metrics={makeGroundedMetrics({
          lookbackDays: 0,
          planModeRatio: 0.5,
        })}
      />
    );
    expect(screen.getByText("all time")).toBeTruthy();
    expect(screen.queryByText(LAST_N_DAYS_PATTERN)).toBeNull();
  });
});
