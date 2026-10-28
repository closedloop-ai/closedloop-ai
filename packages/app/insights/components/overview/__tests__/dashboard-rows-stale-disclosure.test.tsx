/**
 * ISS-10414 — a dashboard row drawing the PREVIOUS range/scope's payload must
 * say so, and no widget inside it may caption itself with the SELECTED period.
 *
 * The recorded defect: at a 7d selection the Event Activity card read "Last 7
 * days · hourly turn density" over a grid running June 18 to September. Both
 * halves were sincere — the caption came from the live selection, the cells came
 * from the 90d payload `keepPreviousData` was still serving — and together they
 * were a lie no reader could detect.
 */
import type { ActivityHeatmap, KpiStat } from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import type { InsightsSectionData } from "@repo/app/insights/components/tile-content";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ROW_UPDATING_DESCRIPTION,
  ROW_UPDATING_LABEL,
  STALE_DELTA_LABEL,
} from "../dashboard-refreshing";
import { DashboardRowContent } from "../dashboard-rows";
import { DASHBOARD_ROWS, DashboardRowTour } from "../dashboard-tiles";

const SELECTED_PERIOD_LABEL = "Last 7 days";
/** What the picker derives; true of the SELECTION, not of a stale payload. */
const SELECTED_DELTA_LABEL = "vs. prior 7 days";
const DELTA_VALUE_PATTERN = /\+5%/;
const statsRow = DASHBOARD_ROWS.find(
  (row) => row.tour === DashboardRowTour.Stats
);

const MERGED_KPI: KpiStat = {
  key: "merged",
  label: "PRs shipped",
  value: 42,
  format: KpiFormat.Number,
  deltaPct: 5,
  sub: "",
};

/** One Delivery KPI carrying a real comparison, so the delta chip renders. */
const SECTIONS_WITH_DELTA: InsightsSectionData = {
  [InsightsSection.Delivery]: {
    kpis: [MERGED_KPI],
    // `kpiSparkline` reads `prTrend.points` unconditionally for `kpi:merged`.
    charts: {
      branchesWithoutPr: [],
      branchLifespan: [],
      meanTimeToMerge: [],
      prByRepo: [],
      prByState: [],
      prTrend: { series: [], points: [] },
    },
  },
};

const SELECTED_PERIOD_PATTERN = /Last 7 days/;
const HOURLY_DENSITY_PATTERN = /hourly turn density/;

const activityRow = DASHBOARD_ROWS.find(
  (row) => row.tour === DashboardRowTour.Activity
);

// Two days of buckets, enough for the card to draw its grid and its caption.
const HEATMAP: ActivityHeatmap = {
  days: ["2026-06-18", "2026-06-19"],
  cells: [{ day: "2026-06-18", hour: 9, human: 2, agent: 3 }],
};

describe("DashboardRowContent stale disclosure", () => {
  it("captions the activity card with the selected period while the row is current", () => {
    // The counterfactual half: with `stale` false the caption DOES claim the
    // selection, so the assertions below pin the stale branch and not a card
    // that never captions itself at all.
    renderActivityRow(false);

    expect(screen.getByText(SELECTED_PERIOD_PATTERN)).toBeInTheDocument();
    expect(screen.queryByText(ROW_UPDATING_LABEL)).not.toBeInTheDocument();
  });

  it("withdraws the selected-period caption and discloses the update while the row is stale", async () => {
    renderActivityRow(true);

    // `await` and not a synchronous read: the disclosure is debounced by
    // `REFRESHING_ONSET_MS` so a section that answers inside the onset never
    // paints chrome at all (review thread, 2026-09-17). This is a deliberate
    // behaviour change in this diff, not a weakened expectation — both the
    // caption withdrawal and the chip are still pinned, and the case below
    // still proves neither appears while the row is current.
    expect(await screen.findByText(ROW_UPDATING_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(SELECTED_PERIOD_PATTERN)).not.toBeInTheDocument();
  });

  it("paints neither the chip nor the withdrawn caption inside the onset delay", async () => {
    // The whole point of the debounce: at the first frames after a range click
    // EVERY section is momentarily stale, so an undebounced flip chipped ten
    // rows and swapped ten captions before undoing all of it.
    renderActivityRow(true);

    expect(screen.queryByText(ROW_UPDATING_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText(SELECTED_PERIOD_PATTERN)).toBeInTheDocument();
    // Positive control on the SAME locators: both do resolve once the onset
    // passes, so the two absences above are the debounce and not dead selectors.
    expect(await screen.findByText(ROW_UPDATING_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(SELECTED_PERIOD_PATTERN)).not.toBeInTheDocument();
  });

  it("announces the sentence from a live region, not an aria-label on the chip", async () => {
    // "Updating" alone does not tell a reader WHICH data they are looking at.
    // The sentence reaches AT through an sr-only `role="status"` region, NOT an
    // `aria-label` on the chip: `Chip` renders a bare span, which maps to
    // `role=generic`, and accname prohibits naming there — so the attribute
    // most likely never reached AT at all (review thread, 2026-09-17).
    renderActivityRow(true);

    const region = await screen.findByText(ROW_UPDATING_DESCRIPTION);
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
    // Sighted readers get it on hover, from the chip itself.
    expect(screen.getByTitle(ROW_UPDATING_DESCRIPTION)).toBeInTheDocument();
  });

  it("keeps the row's content mounted underneath the disclosure", async () => {
    // The capability this ticket must NOT buy its honesty with: the previous
    // range's chart stays fully drawn and legible. Disclosing staleness is the
    // fix; blanking the card would be a second defect wearing a fix's label.
    renderActivityRow(true);
    await screen.findByText(ROW_UPDATING_LABEL);

    expect(screen.getByText("Event Activity")).toBeInTheDocument();
    expect(screen.getByText(HOURLY_DENSITY_PATTERN)).toBeInTheDocument();
  });
});

function renderActivityRow(stale: boolean) {
  if (!activityRow) {
    throw new Error("activity row fixture is missing");
  }
  return render(
    <DashboardRowContent
      autonomySeries={undefined}
      gates={{ agentCollaborationNetwork: true }}
      heatmap={HEATMAP}
      modelSeries={undefined}
      periodLabel={SELECTED_PERIOD_LABEL}
      row={activityRow}
      sections={{}}
      stale={stale}
    />
  );
}

describe("DashboardRowContent stale delta caption", () => {
  // The SECOND range claim a stale row makes (review thread). `deltaLabel` is
  // derived from the picker, never from the payload, so a 90d KPI chip renders
  // "vs. prior 7 days" the instant the reader picks 7d — the same
  // caption-asserts-the-selection / pixels-are-the-previous-one contradiction
  // the period caption had, one widget over.
  it("captions the KPI delta with the selected comparison window while the row is current", () => {
    renderStatsRowWithDelta(false);

    expect(screen.getByText(SELECTED_DELTA_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(STALE_DELTA_LABEL)).not.toBeInTheDocument();
  });

  it("withdraws the selected comparison window while the row is stale", async () => {
    renderStatsRowWithDelta(true);

    expect(await screen.findByText(STALE_DELTA_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(SELECTED_DELTA_LABEL)).not.toBeInTheDocument();
  });

  it("keeps the delta NUMBER while withdrawing only the window it claims", async () => {
    // The capability this must not buy its honesty with: the measured change is
    // still the only answer available and stays on screen. What is withheld is
    // the window the chip claims to compare, not the comparison.
    renderStatsRowWithDelta(true);

    await screen.findByText(STALE_DELTA_LABEL);
    expect(screen.getByText(DELTA_VALUE_PATTERN)).toBeInTheDocument();
  });
});

describe("DashboardRowUpdatingNotice placement", () => {
  it("renders inside the widget card, so it relocates into the expand dialog with it", async () => {
    // Review thread: the notice used to wrap the row from OUTSIDE. Every
    // dashboard widget relocates into the fullscreen dialog as a single
    // portaled subtree rooted at its card, so a wrapper was simply not in what
    // travelled — expanding a stale chart showed the previous range's data in a
    // modal with no disclosure at all. Containment is the property that fixes
    // that, so containment is what this asserts.
    renderActivityRow(true);

    const chip = await screen.findByTitle(ROW_UPDATING_DESCRIPTION);
    const card = chip.closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    // The same card that draws the stale chart, not some other card on the page.
    expect(card?.textContent).toContain("Event Activity");
  });
});

function renderStatsRowWithDelta(stale: boolean) {
  if (!statsRow) {
    throw new Error("stats row fixture is missing");
  }
  return render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DashboardRowContent
        autonomySeries={undefined}
        deltaLabel={SELECTED_DELTA_LABEL}
        gates={{ agentCollaborationNetwork: true }}
        heatmap={undefined}
        modelSeries={undefined}
        periodLabel={SELECTED_PERIOD_LABEL}
        row={statsRow}
        sections={SECTIONS_WITH_DELTA}
        stale={stale}
      />
    </FeatureFlagAdapterProvider>
  );
}
