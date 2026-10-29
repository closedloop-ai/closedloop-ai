import { InsightsSection } from "@repo/api/src/types/insights";
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors";
import { describe, expect, it } from "vitest";
import { isDashboardTourStepReady } from "../tour-step-readiness";

/** Every section settled successfully. */
const SETTLED = {
  [InsightsSection.Delivery]: false,
  [InsightsSection.Utilization]: false,
  [InsightsSection.Agents]: false,
};
const NONE_FAILED = {
  [InsightsSection.Delivery]: false,
  [InsightsSection.Utilization]: false,
  [InsightsSection.Agents]: false,
};

function readiness({
  sectionLoading = SETTLED,
  sectionFailed = NONE_FAILED,
  sessionsLoading = false,
}: {
  sectionLoading?: Record<InsightsSection, boolean>;
  sectionFailed?: Record<InsightsSection, boolean>;
  sessionsLoading?: boolean;
} = {}) {
  return (anchor: DashboardTourAnchor) =>
    isDashboardTourStepReady(anchor, {
      sectionFailed,
      sectionLoading,
      sessionsLoading,
    });
}

describe("isDashboardTourStepReady (ISS-12110)", () => {
  it("holds exactly the beats whose panels read a section still on its first load", () => {
    const ready = readiness({
      sectionLoading: { ...SETTLED, [InsightsSection.Agents]: true },
    });

    expect(ready(DashboardTourAnchor.Models)).toBe(false);
    expect(ready(DashboardTourAnchor.Impact)).toBe(false);
    expect(ready(DashboardTourAnchor.Stats)).toBe(true);
    expect(ready(DashboardTourAnchor.Prs)).toBe(true);
  });

  it("holds the headline row while either section it reads is loading", () => {
    expect(
      readiness({
        sectionLoading: { ...SETTLED, [InsightsSection.Utilization]: true },
      })(DashboardTourAnchor.Stats)
    ).toBe(false);
    expect(
      readiness({
        sectionLoading: { ...SETTLED, [InsightsSection.Delivery]: true },
      })(DashboardTourAnchor.Stats)
    ).toBe(false);
  });

  it("holds the sessions beat on the sessions read alone", () => {
    expect(
      readiness({ sessionsLoading: true })(DashboardTourAnchor.Sessions)
    ).toBe(false);
    expect(
      readiness({
        sectionLoading: {
          [InsightsSection.Delivery]: true,
          [InsightsSection.Utilization]: true,
          [InsightsSection.Agents]: true,
        },
      })(DashboardTourAnchor.Sessions)
    ).toBe(true);
  });

  it("does not wait on a failed read, which keeps its pre-ruling behaviour", () => {
    // A failed section reports `!isSuccess`, so it is in `sectionLoading` too.
    const ready = readiness({
      sectionFailed: { ...NONE_FAILED, [InsightsSection.Agents]: true },
      sectionLoading: { ...SETTLED, [InsightsSection.Agents]: true },
    });

    expect(ready(DashboardTourAnchor.Models)).toBe(true);
    expect(ready(DashboardTourAnchor.Impact)).toBe(true);
  });
});
