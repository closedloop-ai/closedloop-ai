import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  ActivityCoverageCell,
  ActivityCoverageData,
} from "../../lib/diagnostics-payload";
import { CoverageSection } from "../coverage-section";

/**
 * The host's axis vocabulary, pinned here as a LITERAL rather than imported from
 * the desktop shell's map: this suite asserts that a labelled axis renders its
 * label, which is a claim about this component and must not be read off the same
 * object the component is handed by production.
 */
const AXIS_LABELS = { harness: "Harness" } as const;

const NOTHING_ROLLED_UP_RE = /No session has been rolled up yet/;
const HARNESS_AXIS_HEADING_RE = /Coverage by Harness/;
const NOT_COUNTED_RE = /not counted yet/;
const REDERIVED_RE = /re-derived on the next app start/;
const DIFFERENT_FORMULA_RE = /on a different formula version/;
const NEWER_BUILD_RE = /does not have, and it will not recompute them/;

function cell(overrides: Partial<ActivityCoverageCell>): ActivityCoverageCell {
  return {
    coveredSpendUsd: 5,
    totalSpendUsd: 10,
    coverage: 0.5,
    sessionCount: 4,
    lowSample: false,
    spendLowConfUsd: 1,
    spendMediumConfUsd: 2,
    spendHighConfUsd: 3,
    ...overrides,
  };
}

const data: ActivityCoverageData = {
  overall: cell({ coverage: 0.834, coveredSpendUsd: 5, totalSpendUsd: 6 }),
  staleSessionCount: 0,
  unrecognizedFormulaSessionCount: 0,
  axes: [
    {
      axis: "harness",
      buckets: [
        { bucket: "claude_code", cell: cell({ coverage: 0.9 }) },
        {
          bucket: "codex",
          cell: cell({ coverage: 0.1, sessionCount: 1, lowSample: true }),
        },
      ],
    },
  ],
};

describe("CoverageSection", () => {
  it("renders the overall coverage and its basis", () => {
    render(<CoverageSection axisLabels={AXIS_LABELS} coverage={data} />);

    expect(screen.getByText("83.4%")).toBeDefined();
    expect(screen.getByText("Overall coverage")).toBeDefined();
    expect(screen.getByText("Sessions counted")).toBeDefined();
    const sessionCounts = screen.getAllByText("4");
    expect(sessionCounts.some((el) => el.classList.contains("text-2xl"))).toBe(
      true
    );
  });

  it("renders one row per cohort bucket and flags a thin one", () => {
    render(<CoverageSection axisLabels={AXIS_LABELS} coverage={data} />);

    expect(screen.getByText("claude_code")).toBeDefined();
    expect(screen.getByText("90.0%")).toBeDefined();
    expect(screen.getByText("codex")).toBeDefined();
    expect(screen.getByText("10.0%")).toBeDefined();
    // Low sample is a caveat on a shown value, so the number must still render.
    expect(screen.getByText("Low sample")).toBeDefined();
  });

  it("caveats a thin OVERALL figure, not only the per-cohort rows", () => {
    render(
      <CoverageSection
        axisLabels={AXIS_LABELS}
        coverage={{
          ...data,
          overall: cell({ coverage: 1, sessionCount: 1, lowSample: true }),
          axes: [],
        }}
      />
    );
    // Uncaveated, the headline reads as a trustworthy measurement while the
    // rows below — the same sessions — are badged thin.
    expect(screen.getAllByText("Low sample").length).toBeGreaterThan(0);
  });

  it("says the read was unavailable rather than reporting zero coverage", () => {
    render(<CoverageSection axisLabels={AXIS_LABELS} coverage={undefined} />);

    expect(screen.getByText("Coverage unavailable")).toBeDefined();
    // The failure mode this guards: a missing payload rendered as a measured 0%.
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.queryByText("Overall coverage")).toBeNull();
  });

  it("shows a dash, not 0%, for a cohort with no spend to attribute", () => {
    render(
      <CoverageSection
        axisLabels={AXIS_LABELS}
        coverage={{
          overall: cell({
            coverage: 0,
            coveredSpendUsd: 0,
            totalSpendUsd: 0,
            sessionCount: 1,
          }),
          staleSessionCount: 0,
          unrecognizedFormulaSessionCount: 0,
          axes: [
            {
              axis: "harness",
              buckets: [
                {
                  bucket: "opencode",
                  cell: cell({
                    coverage: 0,
                    coveredSpendUsd: 0,
                    totalSpendUsd: 0,
                  }),
                },
              ],
            },
          ],
        }}
      />
    );

    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.0%")).toBeNull();
  });

  it("distinguishes an all-stale corpus from an empty one", () => {
    render(
      <CoverageSection
        axisLabels={AXIS_LABELS}
        coverage={{
          overall: cell({
            coverage: 0,
            coveredSpendUsd: 0,
            totalSpendUsd: 0,
            sessionCount: 0,
          }),
          staleSessionCount: 3,
          unrecognizedFormulaSessionCount: 0,
          axes: [{ axis: "harness", buckets: [] }],
        }}
      />
    );

    // "No session has been rolled up yet" would contradict the same payload's
    // own claim that three sessions are rolled up and awaiting re-derivation.
    expect(screen.queryByText(NOTHING_ROLLED_UP_RE)).toBeNull();
    expect(screen.getByText(DIFFERENT_FORMULA_RE)).toBeDefined();
  });

  it("says nothing has been rolled up rather than rendering empty axes", () => {
    render(
      <CoverageSection
        axisLabels={AXIS_LABELS}
        coverage={{
          overall: cell({
            coverage: 0,
            coveredSpendUsd: 0,
            totalSpendUsd: 0,
            sessionCount: 0,
          }),
          staleSessionCount: 0,
          unrecognizedFormulaSessionCount: 0,
          axes: [{ axis: "harness", buckets: [] }],
        }}
      />
    );

    expect(screen.getByText(NOTHING_ROLLED_UP_RE)).toBeDefined();
    expect(screen.queryByText(HARNESS_AXIS_HEADING_RE)).toBeNull();
  });
});

describe("CoverageSection stale disclosure (ISS-6758)", () => {
  it("says how many sessions were left out of the cells", () => {
    render(
      <CoverageSection
        axisLabels={AXIS_LABELS}
        coverage={{ ...data, staleSessionCount: 2 }}
      />
    );
    expect(screen.getByText("2 sessions not counted yet")).toBeDefined();
  });

  it("says nothing when the whole corpus is on the current formula", () => {
    render(<CoverageSection axisLabels={AXIS_LABELS} coverage={data} />);
    expect(screen.queryByText(NOT_COUNTED_RE)).toBeNull();
  });

  it("does not label the excluded-from count as everything rolled up", () => {
    render(
      <CoverageSection
        axisLabels={AXIS_LABELS}
        coverage={{ ...data, staleSessionCount: 3 }}
      />
    );
    // The card shows only what was COUNTED, so calling it "rolled up" would
    // contradict the alert beneath it reporting 3 more that are.
    expect(screen.queryByText("Sessions rolled up")).toBeNull();
    expect(screen.getByText("Sessions counted")).toBeDefined();
  });

  it("does not promise re-derivation for rows a NEWER build wrote", () => {
    render(
      <CoverageSection
        axisLabels={AXIS_LABELS}
        coverage={{ ...data, unrecognizedFormulaSessionCount: 5 }}
      />
    );
    // The backfill only re-selects rows that are BEHIND, so the stale copy's
    // "re-derived on the next app start" would never come true for these.
    expect(screen.getByText(NEWER_BUILD_RE)).toBeDefined();
    expect(screen.queryByText(REDERIVED_RE)).toBeNull();
  });
});
