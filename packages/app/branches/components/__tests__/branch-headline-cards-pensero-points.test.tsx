import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricId,
} from "@repo/api/src/types/branch-metrics";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { PENSERO_POINTS_PER_DOLLAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import { BranchHeadlineCards } from "../branch-headline-cards";

/**
 * ISS-9814 — the RENDERED branch-detail card, not the resolver behind it.
 *
 * The unit tests around `resolveBranchDetailPerDollar` prove the selection
 * rule; nothing proved the flag actually reaches the component or that the DOM
 * changes. Deleting the `useFeatureFlagEnabledOptional` call, or passing the
 * wrong key, left every one of those unit tests green.
 *
 * Labels are pinned as INDEPENDENT literals rather than re-derived from
 * `perDollarLabelFor`, so a wrong value in that helper cannot make these pass.
 */
const LOC_LABEL =
  BRANCH_METRIC_DICTIONARY[BranchMetricId.DetailLocPerDollar].label;
const PENSERO_LABEL = "Pensero pts / $";

const LOC_RATIO = 5;
const POINTS_RATIO = 2.5;
/**
 * What each formatter actually prints — LOC pads to 2dp, Pensero keeps tenths.
 *
 * The Pensero figure carries the Partial `*`: ISS-9930's ruling made Partial the
 * only state a published Pensero result takes, so a bare "2.5" here would be a
 * fixture no producer can emit.
 */
const LOC_RENDERED = "5.00";
const POINTS_RENDERED = "2.5*";

/** Any card's info popover: `MetricCard` names them all `About <label>`. */
const ANY_INFO_LABEL = /^About /;

describe("Branch detail headline card under pensero-points-per-dollar", () => {
  it("AC2: with the flag OFF it renders LOC/$ even when points are present", () => {
    // Drives the OFF position against a payload that WOULD switch. A case that
    // only supplied LOC metrics here would pass on a broken default.
    renderCards({ penseroEnabled: false });

    expect(screen.getByText(LOC_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(PENSERO_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText(LOC_RENDERED)).toBeInTheDocument();
  });

  it("AC1: with the flag ON it renders the Pensero label and value", () => {
    renderCards({ penseroEnabled: true });

    expect(screen.getByText(PENSERO_LABEL)).toBeInTheDocument();
    // AC6: the LOC label must be GONE, not merely joined — a Pensero number
    // must never appear under it.
    expect(screen.queryByText(LOC_LABEL)).not.toBeInTheDocument();
    // Tenths survive: LOC's formatter would round 2.5 differently and the
    // provider's feed emits tenths verbatim.
    expect(screen.getByText(POINTS_RENDERED)).toBeInTheDocument();
  });

  it("AC3: a measured zero renders 0 under the Pensero label", () => {
    renderCards({ penseroEnabled: true, points: 0 });

    expect(screen.getByText(PENSERO_LABEL)).toBeInTheDocument();
    // The card must show a real zero, not the unavailable placeholder.
    expect(screen.getByText("0*")).toBeInTheDocument();
    expect(screen.queryByText(LOC_LABEL)).not.toBeInTheDocument();
  });

  it("ISS-9930 AC5: the Partial number renders WITH its acquisition disclosure", async () => {
    // AC5's whole claim: the existing Partial vocabulary carries this, so no
    // new badge, chip, tooltip or panel was needed. Since ISS-10540 (product
    // ruling 2026-09-22) that vocabulary is the `*` on the value plus the
    // sentence in the card's info popover. The sentence is located through
    // the rendered constant, never a re-typed literal.
    renderCards({ penseroEnabled: true });

    const card = screen
      .getByText(POINTS_RENDERED)
      .closest<HTMLElement>("[data-slot='card']");
    const trigger = card?.querySelector<HTMLElement>(
      'button[aria-haspopup="dialog"][aria-label^="About "]'
    );
    if (!trigger) {
      throw new Error("Pensero card rendered no info trigger");
    }
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: ANY_INFO_LABEL });
    expect(dialog.textContent).toContain(
      BranchMetricDisclosure.PenseroAcquisitionDaysFailed
    );
  });

  it("an EMPTY delivery table keeps the LOC card even with the flag ON", () => {
    // The likely production state: the org is in the rollout but nothing is
    // backfilled, so the producer omits the field entirely. Distinct from the
    // measured zero above, and it must NOT read as `0 pts`.
    renderCards({ penseroEnabled: true, omitPensero: true });

    expect(screen.getByText(LOC_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(PENSERO_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText(LOC_RENDERED)).toBeInTheDocument();
  });
});

function renderCards({
  penseroEnabled,
  points = POINTS_RATIO,
  omitPensero = false,
}: {
  penseroEnabled: boolean;
  points?: number;
  /** Explicit, not `points: undefined` — that would hit the default above. */
  omitPensero?: boolean;
}) {
  const detail = makeBranchDetail({
    canonicalMetrics: {
      locPerDollar: {
        state: BranchMetricAvailability.Complete,
        value: LOC_RATIO,
      },
      ...(omitPensero
        ? {}
        : {
            penseroPointsPerDollar: {
              state: BranchMetricAvailability.Partial,
              value: points,
              disclosure: BranchMetricDisclosure.PenseroAcquisitionDaysFailed,
            },
          }),
    } as ReturnType<typeof makeBranchDetail>["canonicalMetrics"],
  });
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: penseroEnabled
          ? [PENSERO_POINTS_PER_DOLLAR_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <BranchHeadlineCards detail={detail} />
    </FeatureFlagAdapterProvider>
  );
}
