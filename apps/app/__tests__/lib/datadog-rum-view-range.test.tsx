import {
  RANGE_TO_PERIOD,
  RUM_VIEW_RANGE_UNTAGGED,
  type RumViewRange,
  rumPeriodForRange,
} from "@repo/app/insights/lib/dashboard-range";
import { DateRange } from "@repo/app/shared/lib/format-utils";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const setViewContextProperty = vi.fn();

vi.mock("@datadog/browser-rum", () => ({
  datadogRum: { setViewContextProperty },
}));

afterEach(() => {
  setViewContextProperty.mockReset();
  vi.resetModules();
});

function loadViewRange() {
  return import("@/lib/datadog-rum/view-range");
}

async function renderHarness(period: RumViewRange | null) {
  const { useRumViewRange } = await loadViewRange();

  function Harness({ period: current }: { period: RumViewRange | null }) {
    useRumViewRange(current);
    return null;
  }

  const view = render(<Harness period={period} />);
  return {
    setPeriod: (next: RumViewRange | null) =>
      view.rerender(<Harness period={next} />),
  };
}

describe("useRumViewRange", () => {
  /**
   * ISS-7250 AC2. The whole point of the ticket is the CHANGE path: an
   * attribute written once on mount would leave every post-change page load
   * attributed to the range the user started on. Asserting the full call list
   * (rather than "a setter ran") also pins the key name and proves no second
   * write sneaks in.
   */
  it("rewrites the attribute when the selected range changes", async () => {
    const { setPeriod } = await renderHarness("7");

    setPeriod("90");

    expect(setViewContextProperty.mock.calls).toEqual([
      ["range_days", "7"],
      ["range_days", "90"],
    ]);
  });

  /**
   * ISS-7250 AC4. The negative ("no PII") is trivially satisfied by writing
   * nothing at all, so the positive assertion — the range IS reported — shares
   * this test. The argument count is the negative half: a literal date, org,
   * user id, or slug could only ride along as extra arguments or extra calls.
   */
  it("reports the range bucket and carries nothing else", async () => {
    await renderHarness("90");

    expect(setViewContextProperty).toHaveBeenCalledTimes(1);
    expect(setViewContextProperty.mock.calls[0]).toEqual(["range_days", "90"]);
    expect(setViewContextProperty.mock.calls[0]).toHaveLength(2);
  });

  /**
   * The attribute's value set is closed to these four bucket labels, which is
   * what makes AC4 hold by construction. Literals are hand-written on both
   * sides on purpose: deriving them from the map under test would stay green if
   * a member were deleted or repointed at a user-supplied window.
   */
  it("is closed to the four bucket labels", () => {
    expect([
      RANGE_TO_PERIOD["7d"],
      RANGE_TO_PERIOD["30d"],
      RANGE_TO_PERIOD["90d"],
      RANGE_TO_PERIOD.all,
    ]).toEqual(["7", "30", "90", "all"]);
  });

  /**
   * ISS-12660 (tamsinb review on #8938). The two inputs the old
   * `InsightsPeriod | null` signature collapsed: NOT READY leaves the view
   * alone, an unnameable range CLEARS it. Switching away from 7d and asserting
   * the full call list is the only way to catch the stale tag — a test that
   * only mounted at 60d would pass with no write at all.
   */
  it("clears the attribute when the range leaves the taggable set", async () => {
    const { setPeriod } = await renderHarness(RANGE_TO_PERIOD["7d"]);

    setPeriod(rumPeriodForRange(DateRange.Last60Days));

    expect(setViewContextProperty.mock.calls).toEqual([
      ["range_days", "7"],
      ["range_days", undefined],
    ]);
  });

  it("leaves the view untouched while the window is not known yet", async () => {
    const { setPeriod } = await renderHarness(null);

    expect(setViewContextProperty).not.toHaveBeenCalled();

    setPeriod(RANGE_TO_PERIOD["30d"]);

    expect(setViewContextProperty.mock.calls).toEqual([["range_days", "30"]]);
  });

  it("marks 60d untagged and every taggable range by its bucket", () => {
    expect(rumPeriodForRange(DateRange.Last60Days)).toBe(
      RUM_VIEW_RANGE_UNTAGGED
    );
    expect([
      rumPeriodForRange(DateRange.Last7Days),
      rumPeriodForRange(DateRange.Last30Days),
      rumPeriodForRange(DateRange.Last90Days),
      rumPeriodForRange(DateRange.AllTime),
    ]).toEqual(["7", "30", "90", "all"]);
  });

  it("does not surface an SDK failure to the rendering page", async () => {
    setViewContextProperty.mockImplementation(() => {
      throw new Error("rum not started");
    });

    await expect(renderHarness("7")).resolves.toBeDefined();
  });
});
