/**
 * ISS-9853 — the Packs Performance "Success rate" tile said two things it could
 * not back up: its VALUE sat under "Share of the pack's sessions…" while the
 * server may have computed it over a bounded sample of that cohort, and its
 * DELTA sat under a bare "vs. baseline" while the comparator was a bounded
 * most-recent sample of the window.
 *
 * `success-rate-readout.test.ts` pins the copy itself; this drives the real
 * `PackDetail` render behind the real flag, so the tile cannot go back to
 * hardcoding either caption while the readout stays green. `PackDetail` is
 * mounted by BOTH shells, so this one mount is the shared render for web and
 * desktop; the desktop adapter's own join is
 * `apps/desktop/src/renderer/components/agents/__tests__/pack-detail-merged-prs-adapter.test.tsx`.
 */
import {
  type AgentComponentDetail,
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { agentComponentToPackAnalytics } from "../../lib/agent-component-to-analytics";
import {
  metricCardHintName,
  metricCardText,
} from "../../lib/metric-card-test-readout";
import type { PackPerformance, PackView } from "../../lib/pack-view";
import { mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PackDetail } from "../pack-detail";

const CONTEXT = createPacksContext(PacksMode.WebAdmin);
const BASE_PACK = mockPackViews[0];
const SUCCESS_RATE_LABEL = "Success rate";
const SHIPPED_DELTA_LABEL = "vs. baseline";
/** Sessions the comparator was sampled from, when the window held more. */
const BASELINE_SAMPLE = 500;

type Coverage = Partial<
  Pick<PackPerformance, "baselineSampleSize" | "mergedPrsTruncated">
>;

describe("PackDetail Success rate tile — coverage disclosure (ISS-9853)", () => {
  it("says nothing about either sample while the flag is off", () => {
    renderTile({
      baselineSampleSize: BASELINE_SAMPLE,
      mergedPrsTruncated: true,
    });

    // Closed by default: the shipped tile, byte for byte, even though this
    // response declares BOTH populations were sampled.
    expect(successRateCardText()).toContain(SHIPPED_DELTA_LABEL);
    expect(successRateCardText()).not.toContain("baseline sessions");
  });

  it("names the comparator's sample in the delta caption with the flag on", () => {
    renderTile({ baselineSampleSize: BASELINE_SAMPLE }, { honest: true });

    expect(successRateCardText()).toContain("vs. last 500 baseline sessions");
    expect(successRateCardText()).not.toBe(SHIPPED_DELTA_LABEL);
  });

  it("keeps the shipped caption when the comparator covered the window", () => {
    renderTile({ baselineSampleSize: null }, { honest: true });

    expect(successRateCardText()).toContain(SHIPPED_DELTA_LABEL);
  });

  it("keeps the shipped caption when the producer declared no coverage", () => {
    const performance = webAdapterPerformance({});
    // A server predating the field: it sampled the same way and could not say
    // so, which is not the same as declaring a whole-window comparison.
    expect(performance.baselineSampleSize).toBeUndefined();
    renderPerformanceTab(performance, { honest: true });

    expect(successRateCardText()).toContain(SHIPPED_DELTA_LABEL);
  });

  it("narrows the value's population copy when the cohort itself was sampled", async () => {
    renderTile({ mergedPrsTruncated: true }, { honest: true });

    const hint = await openSuccessRateHint();

    expect(hint).toHaveTextContent("Share of a sample");
    expect(hint).toHaveTextContent("higher or lower");
  });

  it("keeps the whole-population copy when the cohort was complete", async () => {
    renderTile({ mergedPrsTruncated: false }, { honest: true });

    const hint = await openSuccessRateHint();

    expect(hint).toHaveTextContent("Share of the pack's sessions");
    expect(hint).not.toHaveTextContent("Share of a sample");
  });

  it("carries a sampled cohort through the web adapter to the render", async () => {
    // Starts one field earlier, at the `AgentComponentDetail` the web surface
    // fetches: the adapter is inside the assertion rather than beside it.
    renderPerformanceTab(webAdapterPerformance({ mergedPrsTruncated: true }), {
      honest: true,
    });

    expect(await openSuccessRateHint()).toHaveTextContent("Share of a sample");
  });

  it("carries a declared comparator sample through the web adapter", () => {
    renderPerformanceTab(
      webAdapterPerformance({ baselineSampleSize: BASELINE_SAMPLE }),
      { honest: true }
    );

    expect(successRateCardText()).toContain("vs. last 500 baseline sessions");
  });
});

function renderTile(coverage: Coverage, options: { honest?: boolean } = {}) {
  const performance = BASE_PACK.performance;
  if (!performance) {
    throw new Error("fixture pack must carry a performance block");
  }
  renderPerformanceTab({ ...performance, ...coverage }, options);
}

function renderPerformanceTab(
  performance: PackPerformance,
  options: { honest?: boolean } = {}
): void {
  const nav = createMemoryNavigation({
    initialPath: "/packs/code?tab=performance",
    orgSlug: "org-test",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: options.honest
          ? [AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
    </FeatureFlagAdapterProvider>
  );
  const pack: PackView = { ...BASE_PACK, performance };
  render(<PackDetail context={CONTEXT} pack={pack} />, { wrapper });
}

/** Everything the Success-rate card renders, caption included. */
function successRateCardText(): string {
  return metricCardText(screen, SUCCESS_RATE_LABEL);
}

/**
 * Open the Success-rate card's info hint and return its popover. The headline
 * and caveat live behind a disclosure, so a reader only meets them here.
 */
async function openSuccessRateHint(): Promise<HTMLElement> {
  const hintName = metricCardHintName(SUCCESS_RATE_LABEL);
  await userEvent.click(screen.getByRole("button", { name: hintName }));
  return await screen.findByRole("dialog", { name: hintName });
}

/**
 * The `performance` block the web adapter produces for a component payload —
 * the real mapper, from the real wire shape.
 */
function webAdapterPerformance(coverage: Coverage): PackPerformance {
  const component = {
    branchesTab: [],
    branchesTabTruncated: false,
    collaborators: [],
    computeTargetIds: ["ct-1"],
    efficiencyTrend: [],
    firstSeenAt: "2026-07-01T00:00:00Z",
    harness: Harness.Claude,
    id: "iss-9853-component",
    invocations: 1284,
    kind: AgentComponentKind.Plugin,
    lastSeenAt: "2026-07-08T00:00:00Z",
    locDelta: null,
    locPerDollar: 3.2,
    mergedPrs: 996,
    name: "code",
    prompt: null,
    properties: { format: "md", path: "code" },
    provenance: [],
    qualityDelta: null,
    qualityScore: null,
    resolvedState: "unresolved",
    sessions: 7247,
    sessionsTab: [],
    sessionsTabTruncated: false,
    slug: "plugin::code",
    source: "closedloop-ai",
    sourceType: "pack",
    successDelta: 9,
    successRate: 62,
    tokenEfficiencyDelta: null,
    trend: [],
    usageSessions: [],
    versions: [],
    ...coverage,
  } as AgentComponentDetail;

  return agentComponentToPackAnalytics(component).performance;
}
