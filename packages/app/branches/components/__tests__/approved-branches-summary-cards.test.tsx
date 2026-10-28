import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { NO_COMPARISON_LABEL } from "@repo/app/insights/components/kpi-delta-placeholder";
import {
  restoreGridTier,
  stubGridTier,
} from "@repo/app/shared/components/__tests__/summary-card-grid-tier-stub";
import {
  restoreTrackStub,
  stubTrackGap,
  stubTrackWidth,
  type TrackStubDescriptors,
} from "@repo/app/shared/components/__tests__/summary-card-track-stub";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { LIST_SUMMARY_LOADING_DETAIL } from "@repo/app/shared/lib/list-summary-loading-detail";
import { CardDensity } from "@repo/design-system/components/ui/card-density";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPARISON_PERIOD_NOUN,
  describeMissingBranchComparison,
} from "../../lib/branch-list-comparison-copy";
import { BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY } from "../../lib/branches-summary-honest-loading-flag";
import { BRANCH_METRIC_UNAVAILABLE_DETAIL } from "../approved-branch-metric-card";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

/**
 * ISS-5714: `MEDIAN PR SIZE` rendered `148 LOC*` with the bare word
 * `Unavailable` in the footer slot directly beneath it — a value and a denial of
 * that value in one tile. The value was real; only the period-over-period
 * comparison was missing, and the placeholder never said so.
 */
const PARTIAL_MEDIAN_PR_SIZE = {
  current: {
    state: BranchMetricAvailability.Partial,
    value: 148,
    coverage: { included: 4, total: 6 },
    disclosure: BranchMetricDisclosure.PrIncomplete,
  },
  comparison: {
    label: BranchMetricComparisonLabel.MonthOverMonth,
    priorWindow: {
      startAt: "2026-06-06T00:00:00.000Z",
      endAt: "2026-07-06T00:00:00.000Z",
    },
    deltaPct: {
      state: BranchMetricAvailability.Unavailable,
      value: null,
    },
  },
} as const;

function placeholderForMedian(): HTMLElement | undefined {
  return screen
    .getAllByTestId("kpi-delta-placeholder")
    .find((node) =>
      node.closest("[data-slot='card']")?.textContent?.includes("148 LOC")
    );
}

function renderApproved() {
  return render(
    <ApprovedBranchesSummaryCards
      cardClassName="card"
      isError={false}
      isPending={false}
      metrics={makeBranchListMetrics({
        medianPrSize: PARTIAL_MEDIAN_PR_SIZE,
      })}
    />
  );
}

function renderWithHonestLoading(
  props: ComponentProps<typeof ApprovedBranchesSummaryCards>
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY],
      })}
    >
      <ApprovedBranchesSummaryCards {...props} />
    </FeatureFlagAdapterProvider>
  );
}

function renderPendingWithoutFlag(
  props: Partial<ComponentProps<typeof ApprovedBranchesSummaryCards>> = {}
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
    >
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending
        metrics={undefined}
        {...props}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("ApprovedBranchesSummaryCards (ISS-5714)", () => {
  it("never prints a bare denial under a value it did render", () => {
    renderApproved();

    // The value is real and still on screen.
    expect(screen.getByText("148 LOC*")).toBeInTheDocument();
    // …and nothing beside it says the unqualified word that reads as a denial
    // of that value. The three settled "Unavailable" captions in this row all
    // belong to cards whose VALUE is a dash, never to one showing a number.
    for (const denial of screen.queryAllByText(
      BRANCH_METRIC_UNAVAILABLE_DETAIL
    )) {
      const card = denial.closest("[data-slot='card']");
      expect(card?.textContent).not.toContain("148 LOC");
    }
  });

  it("names the comparison as the missing thing, not the value", () => {
    renderApproved();

    const medianPlaceholder = placeholderForMedian();
    expect(medianPlaceholder).toBeDefined();
    expect(medianPlaceholder?.textContent).toContain("No comparison");
    // The reason travels with the chip in an `sr-only` sentence, and it scopes
    // the gap to the comparison window rather than to the value.
    expect(medianPlaceholder?.textContent).toContain(
      describeMissingBranchComparison({
        state: BranchMetricAvailability.Unavailable,
        label: BranchMetricComparisonLabel.MonthOverMonth,
        comparisonSuppressedByFilter: false,
      })
    );
  });

  /**
   * `bindCanonicalMetricsToFilteredRows` blanks every delta when it recomputes the bundle
   * over the filtered rows, so THERE the cause is always the filter. Blaming the
   * period would make the reader's own data look like the problem (FEA-4241),
   * and it would tell a different story from the "Not available with filters
   * applied" caption the no-value cards in the same row already show.
   */
  it("blames the filter, not the period, when the filtered fallback suppressed the comparison", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        comparisonSuppressedByFilter
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          medianPrSize: PARTIAL_MEDIAN_PR_SIZE,
        })}
      />
    );

    const reason = placeholderForMedian()?.textContent ?? "";
    expect(reason).toContain("filters");
    expect(reason).not.toContain(
      COMPARISON_PERIOD_NOUN[BranchMetricComparisonLabel.MonthOverMonth]
    );
  });

  /**
   * `NotApplicable` means no percentage is asserted for this window — a
   * near-zero base, or since ISS-10540 a movement past `pctDelta`'s ±999
   * ceiling — NOT that the metric is never compared. A sibling card can be
   * showing a live delta for the same window, which would make that claim
   * visibly false.
   *
   * ISS-10540 flipped the sentence this pins: the period-specific "The previous
   * month has no value to compare against." was true for the zero-prior cause
   * only, and the ceiling cause has a prior WITH a value. The copy map now names
   * no cause for this state, so the placeholder states its own cause-agnostic
   * ISS-5003 sentence — the one the Sessions strip already shows for the same
   * decline. Located through the component's own constant, because that
   * default IS the contract here.
   */
  it("does not claim a metric is uncompared when only its baseline is missing", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          medianPrSize: {
            current: PARTIAL_MEDIAN_PR_SIZE.current,
            comparison: {
              ...PARTIAL_MEDIAN_PR_SIZE.comparison,
              deltaPct: {
                state: BranchMetricAvailability.NotApplicable,
                value: null,
              },
            },
          },
        })}
      />
    );

    const reason = placeholderForMedian()?.textContent ?? "";
    expect(reason).toContain(NO_COMPARISON_LABEL);
    expect(reason).not.toContain("previous month");
    expect(reason).not.toContain("not compared");
  });

  /**
   * A chip reading "No comparison" over a caption reading "MoM" is the same
   * contradiction, one line down, that this card just stopped printing.
   */
  it("drops the bare window caption while the chip is explaining itself", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          activeBranches: {
            current: { state: BranchMetricAvailability.Complete, value: 12 },
            comparison: {
              ...PARTIAL_MEDIAN_PR_SIZE.comparison,
            },
          },
        })}
      />
    );

    const card = screen
      .getAllByTestId("kpi-delta-placeholder")[0]
      ?.closest("[data-slot='card']");
    expect(card?.textContent).toContain("12");
    expect(card?.textContent).not.toContain(
      BranchMetricComparisonLabel.MonthOverMonth
    );
  });

  it("types an omitted finite-window comparison instead of showing a bare caption", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          medianPrSize: { current: PARTIAL_MEDIAN_PR_SIZE.current },
        })}
      />
    );

    expect(screen.getByText("148 LOC*")).toBeInTheDocument();
    const placeholder = placeholderForMedian();
    expect(placeholder?.textContent).toContain("No comparison");
    expect(placeholder?.textContent).toContain("missing data");
    const card = placeholder?.closest("[data-slot='card']");
    expect(card?.textContent).not.toContain(
      BranchMetricComparisonLabel.MonthOverMonth
    );
  });

  it("renders no comparison affordance for the all-time range", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          period: BranchMetricPeriod.All,
          label: BranchMetricComparisonLabel.AllTime,
          medianPrSize: { current: PARTIAL_MEDIAN_PR_SIZE.current },
        })}
      />
    );

    expect(screen.getByText("148 LOC*")).toBeInTheDocument();
    expect(screen.queryByTestId("kpi-delta-placeholder")).toBeNull();
  });
});

/** The five cards of the row, and the two slots a comparing shell skeletons. */
const BRANCH_CARD_COUNT = 5;
const SKELETONS_PER_COMPARING_CARD = 2;

describe("ApprovedBranchesSummaryCards honest never-loaded state (ISS-8510)", () => {
  it("keeps the legacy dimmed dash while the flag is OFF", () => {
    const { container } = renderPendingWithoutFlag({
      reservesPendingComparisonSlot: true,
    });

    expect(screen.getAllByText(KPI_NO_VALUE)).toHaveLength(BRANCH_CARD_COUNT);
    expect(screen.getAllByText(LIST_SUMMARY_LOADING_DETAIL)).toHaveLength(
      BRANCH_CARD_COUNT
    );
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("hides metrics-backed pending fallbacks while the flag is OFF", () => {
    const { container } = renderPendingWithoutFlag({
      metrics: makeBranchListMetrics({
        activeBranches: {
          current: { state: BranchMetricAvailability.Complete, value: 12 },
        },
      }),
      reservesPendingComparisonSlot: true,
    });

    expect(screen.queryByText("12")).toBeNull();
    expect(screen.getAllByText(KPI_NO_VALUE)).toHaveLength(BRANCH_CARD_COUNT);
    expect(screen.getAllByText(LIST_SUMMARY_LOADING_DETAIL)).toHaveLength(
      BRANCH_CARD_COUNT
    );
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("skeletons values and finite comparison slots before the first bundle loads", () => {
    const { container } = renderWithHonestLoading({
      cardClassName: "card",
      isError: false,
      isPending: true,
      metrics: undefined,
      reservesPendingComparisonSlot: true,
    });

    expect(screen.queryByText(KPI_NO_VALUE)).toBeNull();
    expect(screen.getAllByText(LIST_SUMMARY_LOADING_DETAIL)).toHaveLength(
      BRANCH_CARD_COUNT
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      BRANCH_CARD_COUNT * SKELETONS_PER_COMPARING_CARD
    );
    expect(
      container.querySelectorAll('[class~="h-4"][class~="w-24"]')
    ).toHaveLength(BRANCH_CARD_COUNT);
  });

  it("does not reserve a comparison slot for all time while never-loaded", () => {
    const { container } = renderWithHonestLoading({
      cardClassName: "card",
      isError: false,
      isPending: true,
      metrics: undefined,
      reservesPendingComparisonSlot: false,
    });

    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      BRANCH_CARD_COUNT
    );
    expect(container.querySelector('[class~="h-4"][class~="w-24"]')).toBeNull();
  });

  /**
   * ISS-8510 scoped the shell to a bundle-less pending read and left a
   * metrics-backed one on the dimmed dash, so the row had TWO wait treatments
   * where Sessions has one. ISS-9887 deliberately retires that split: a wait is a
   * wait, and both surfaces now render the one shared loading strip for it. The
   * dimmed dash is still exactly what a flag-OFF reader sees (the two tests
   * above), and it is still what a FAILED read renders (the test below).
   */
  it("skeletons a metrics-backed pending refresh too, like the Sessions strip", () => {
    const { container } = renderWithHonestLoading({
      cardClassName: "card",
      isError: false,
      isPending: true,
      metrics: makeBranchListMetrics({
        activeBranches: {
          current: { state: BranchMetricAvailability.Complete, value: 12 },
        },
      }),
      reservesPendingComparisonSlot: true,
    });

    expect(screen.queryByText("12")).toBeNull();
    expect(screen.queryByText(KPI_NO_VALUE)).toBeNull();
    expect(screen.getAllByText(LIST_SUMMARY_LOADING_DETAIL)).toHaveLength(
      BRANCH_CARD_COUNT
    );
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      BRANCH_CARD_COUNT * SKELETONS_PER_COMPARING_CARD
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("keeps failed or non-pending missing reads on the unavailable dash path", () => {
    const { container: failed } = renderWithHonestLoading({
      cardClassName: "card",
      isError: true,
      isPending: false,
      metrics: undefined,
      reservesPendingComparisonSlot: true,
    });
    expect(screen.getAllByText(KPI_NO_VALUE)).toHaveLength(BRANCH_CARD_COUNT);
    expect(screen.getAllByText(BRANCH_METRIC_UNAVAILABLE_DETAIL)).toHaveLength(
      BRANCH_CARD_COUNT
    );
    expect(failed.querySelector('[data-slot="skeleton"]')).toBeNull();

    const { container: missing } = renderWithHonestLoading({
      cardClassName: "card",
      isError: false,
      isPending: false,
      metrics: undefined,
      reservesPendingComparisonSlot: true,
    });
    expect(missing.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});

describe("card figures under a non-US default locale (ISS-7336)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts the suite on a German-default machine, so an inherited locale shows", () => {
    useGermanDefaultLocale();
    // Guards the harness itself. If this stub ever stops biting, both
    // assertions below would pass against the exact bug they exist to catch.
    expect(new Intl.NumberFormat(undefined, USD).format(1234.56)).toContain(
      "1.234,56"
    );
    expect(new Intl.NumberFormat("en-US", USD).format(1234.56)).toBe(
      "$1,234.56"
    );
  });

  it("renders a plain count in that same canonical locale", () => {
    useGermanDefaultLocale();
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          activeBranches: {
            current: {
              state: BranchMetricAvailability.Complete,
              value: 12_500,
            },
          },
        })}
      />
    );

    expect(screen.getByText("12,500")).toBeInTheDocument();
    expect(screen.queryByText("12.500")).toBeNull();
  });

  /**
   * The `round()` and `Lines` routes (`LOC`, `LOC/$`), which the plain-count
   * case above never reaches. ISS-9970 retired this row's only currency card, so
   * there is no currency route left to pin here.
   */
  it("renders the rounded and LOC routes in that same canonical locale", () => {
    useGermanDefaultLocale();
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          canonicalLocPerDollar: {
            current: {
              state: BranchMetricAvailability.Complete,
              value: 1234.5,
            },
          },
          medianPrSize: {
            current: {
              state: BranchMetricAvailability.Complete,
              value: 12_500,
            },
          },
          mergeRatePct: {
            current: { state: BranchMetricAvailability.Complete, value: 85.5 },
          },
        })}
      />
    );

    expect(screen.getByText("1,234.5 LOC/$")).toBeInTheDocument();
    expect(screen.queryByText("1.234,5 LOC/$")).toBeNull();
    expect(screen.getByText("12,500 LOC")).toBeInTheDocument();
    expect(screen.queryByText("12.500 LOC")).toBeNull();
    expect(screen.getByText("85.5%")).toBeInTheDocument();
    expect(screen.queryByText("85,5%")).toBeNull();
  });
});

const USD: Intl.NumberFormatOptions = {
  currency: "USD",
  maximumFractionDigits: 2,
  style: "currency",
};

/** The real constructor, captured before any spy can replace it. */
const RealNumberFormat = Intl.NumberFormat;
/** The real formatter, captured before any spy can replace it. */
const REAL_TO_LOCALE_STRING: (
  this: number,
  locales?: Intl.LocalesArgument,
  options?: Intl.NumberFormatOptions
) => string = Number.prototype.toLocaleString;

/**
 * Resolves an omitted locale to German for the rest of the test. A US runner
 * renders an inherited locale and an explicit `en-US` identically, so without
 * this the regression is invisible and the counterfactual cannot red. Both
 * routes this card formats through are covered: `Intl.NumberFormat` for the
 * currency and rounded units, `toLocaleString` for the plain counts.
 */
function useGermanDefaultLocale(): void {
  // biome-ignore lint/complexity/useArrowFunction: production calls this with `new`, and an arrow is not constructable.
  vi.spyOn(Intl, "NumberFormat").mockImplementation(function (
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions
  ): Intl.NumberFormat {
    return new RealNumberFormat(locales ?? "de-DE", options);
  });
  vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (
    this: number,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions
  ): string {
    return REAL_TO_LOCALE_STRING.call(this, locales ?? "de-DE", options);
  });
}

/**
 * ISS-10540 (operator ruling, Tamsin, 2026-09-21): the Branches listing strip
 * PINS the Compact density tier, so it and the Sessions strip read at one
 * vertical rhythm. This is the strip the ruling was measured on: ISS-9730 hides
 * cards with no value, so the three survivors fit roomy at any desktop track and
 * the measured tier resolved Comfortable while Sessions' five resolved Compact.
 * The case stands the row at the five-card comfortable crossover (1364px) so the
 * un-pinned answer would be Comfortable however many cards survive; an
 * unmeasured jsdom row folds to Compact on its own and would pass with the prop
 * deleted.
 */
describe("ApprovedBranchesSummaryCards (ISS-10540 — pinned density)", () => {
  const FIVE_CARD_COMFORTABLE_TRACK = 1364;
  let gridTier: PropertyDescriptor | undefined;
  let trackStub: TrackStubDescriptors | undefined;

  beforeEach(() => {
    gridTier = stubGridTier(true);
    trackStub = stubTrackGap();
    stubTrackWidth(FIVE_CARD_COMFORTABLE_TRACK);
  });

  afterEach(() => {
    if (trackStub) {
      restoreTrackStub(trackStub);
      trackStub = undefined;
    }
    restoreGridTier(gridTier);
    gridTier = undefined;
  });

  it("pins the row Compact at a track where the measurement resolves Comfortable", () => {
    const { container } = renderApproved();

    const row = container
      .querySelector('[data-slot="card"]')
      ?.closest<HTMLElement>("[data-density]");
    expect(row).not.toBeNull();
    expect(row?.dataset.density).toBe(CardDensity.Compact);
  });
});
