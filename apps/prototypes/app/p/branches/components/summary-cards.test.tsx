// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DateRange } from "../mock";
import {
  BRANCH_METRIC_FIXTURE_NOW,
  buildGeneratedBranchFixture,
} from "./branch-list-fixtures";
import { MetricPresentationState } from "./branch-list-metric-types";
import { calculateBranchListMetrics } from "./branch-list-metrics";
import { BranchesSummaryCards } from "./summary-cards";

const STARRED_VALUE_PATTERN = /\*$/;
const INCOMPLETE_DISCLOSURE_PATTERN = /Some qualifying values are unavailable/;
const LOC_PER_DOLLAR_VALUE_PATTERN = / LOC\/\$$/;
const LOC_VALUE_PATTERN = / LOC$/;
const EXCESS_DELTA_PRECISION_PATTERN = /\.\d{2,}%/;

const fixture = buildGeneratedBranchFixture(3);
const metrics = calculateBranchListMetrics(
  fixture.rows.map((row) => row.id),
  fixture.evidence,
  DateRange.ThirtyDays,
  BRANCH_METRIC_FIXTURE_NOW
);

describe("BranchesSummaryCards", () => {
  it("renders the five canonical cards in fixed order", () => {
    const { container } = render(
      <BranchesSummaryCards
        metrics={metrics}
        presentationState={MetricPresentationState.Complete}
      />
    );

    const labels = [
      ...container.querySelectorAll("[data-slot='card-description']"),
    ].map((node) => node.textContent?.trim());
    expect(labels).toEqual([
      "Active branches",
      "LOC per $",
      "Median PR size",
      "AI spend",
      "Merge rate",
    ]);
    expect(screen.queryByText("Value per $")).toBeNull();
    expect(screen.getByText(LOC_PER_DOLLAR_VALUE_PATTERN)).toBeTruthy();
    expect(screen.getByText(LOC_VALUE_PATTERN)).toBeTruthy();
  });

  it("formats comparison deltas and names their period once per card", () => {
    render(
      <BranchesSummaryCards
        metrics={metrics}
        presentationState={MetricPresentationState.Complete}
      />
    );

    const cards = screen
      .getAllByTestId("metric-delta-chip")
      .map((chip) => chip.closest("[data-slot='card']"));
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card?.textContent).not.toMatch(EXCESS_DELTA_PRECISION_PATTERN);
      expect(card?.textContent?.match(/MoM/g)).toHaveLength(1);
    }
  });

  it("keeps partial values numeric, starred, disclosed, and comparison-free", () => {
    render(
      <BranchesSummaryCards
        metrics={metrics}
        presentationState={MetricPresentationState.Partial}
      />
    );

    expect(screen.getAllByText(STARRED_VALUE_PATTERN).length).toBeGreaterThan(
      0
    );
    expect(
      screen.getAllByText(INCOMPLETE_DISCLOSURE_PATTERN).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Partial")).toBeNull();
  });

  it.each([
    [MetricPresentationState.Unavailable, "Unavailable"],
    [MetricPresentationState.NotApplicable, "N/A"],
    [MetricPresentationState.NoData, "No data"],
    [MetricPresentationState.Loading, "Loading"],
    [MetricPresentationState.Error, "Unavailable"],
  ])("renders %s independently from zero", (state, label) => {
    render(
      <BranchesSummaryCards metrics={metrics} presentationState={state} />
    );

    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });
});
