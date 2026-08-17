import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { agentComponentToPackAnalytics } from "../../lib/agent-component-to-analytics";
import type { PackPerformance, PackView } from "../../lib/pack-view";
import { mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PackDetail } from "../pack-detail";

/**
 * ISS-6462 — the Packs Performance tab rendered `mergedPrs` through
 * `NUMBER_FORMAT.format` with no `+` and no caveat, while the server counts
 * distinct merged PRs over only the first `COHORT_SCAN_CAP` cohort sessions. A
 * pack whose cohort exceeds that cap therefore showed a confident undercount.
 *
 * `merged-prs-readout.test.ts` pins the readout itself; this drives the real
 * `PackDetail` → `MetricCard` render, so the tile cannot go back to formatting
 * the count inline while the readout stays green. `PackDetail` is mounted by
 * BOTH shells (web `apps/app` and the desktop renderer), so this one mount is
 * the shared render for both.
 */

const CONTEXT = createPacksContext(PacksMode.WebAdmin);
const BASE_PACK = mockPackViews[0];
const MERGED_PRS_LABEL = "Merged PRs";
const MERGED_PRS_FLOOR = 996;

function basePerformance(): PackPerformance {
  const performance = BASE_PACK.performance;
  if (!performance) {
    throw new Error("fixture pack must carry a performance block");
  }
  return { ...performance, mergedPrs: MERGED_PRS_FLOOR };
}

function renderPerformanceTab(performance: PackPerformance): void {
  const nav = createMemoryNavigation({
    initialPath: "/packs/code?tab=performance",
    orgSlug: "org-test",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const pack: PackView = { ...BASE_PACK, performance };
  render(<PackDetail context={CONTEXT} pack={pack} />, { wrapper });
}

/** The rendered headline of the tile whose label is "Merged PRs". */
function mergedPrsTileText(): string {
  const card = screen.getByText(MERGED_PRS_LABEL).closest("[data-slot='card']");
  if (!card) {
    throw new Error("the Merged PRs label is not inside a card");
  }
  const title = card.querySelector("[data-slot='card-title']");
  if (!title) {
    throw new Error("the Merged PRs card rendered no value");
  }
  return title.textContent?.trim() ?? "";
}

describe("PackDetail Merged PRs tile (ISS-6462)", () => {
  it("marks a capped cohort scan as a floor", () => {
    renderPerformanceTab({ ...basePerformance(), mergedPrsTruncated: true });

    expect(mergedPrsTileText()).toBe("996+");
  });

  it("prints a whole-cohort count bare, so the marker means something", () => {
    renderPerformanceTab({ ...basePerformance(), mergedPrsTruncated: false });

    expect(mergedPrsTileText()).toBe("996");
  });

  it("does not invent a floor marker when coverage was never declared", () => {
    // Built with the flag present, then removed, so the omission is explicit
    // rather than an artifact of the fixture never having set it.
    const performance: PackPerformance = {
      ...basePerformance(),
      mergedPrsTruncated: true,
    };
    Reflect.deleteProperty(performance, "mergedPrsTruncated");
    renderPerformanceTab(performance);

    expect(mergedPrsTileText()).toBe("996");
  });
});

/**
 * ISS-6462 (wongk, #5096 review): the same tile, driven from the WEB ADAPTER's
 * own input instead of a pre-mapped `PackPerformance`.
 *
 * The suite above hands `PackDetail` a block that already carries the flag, and
 * `agent-component-to-analytics.test.ts` pins the mapper on its own — so each
 * half is covered and the JOIN is not. This starts one field earlier, at the
 * `AgentComponentDetail` the web surface actually fetches (`usePackAnalytics` →
 * `use-pack-dashboard-selection`), and reads the rendered tile: the adapter is
 * inside the assertion rather than beside it, which is what a field going
 * missing in transit actually looks like.
 *
 * The desktop adapter's twin of this is
 * `apps/desktop/src/renderer/components/agents/__tests__/pack-detail-merged-prs-adapter.test.tsx`.
 */
describe("PackDetail Merged PRs tile, through the web adapter (ISS-6462)", () => {
  it("carries a declared cap from the component payload to the rendered floor", () => {
    renderPerformanceTab(webAdapterPerformance({ mergedPrsTruncated: true }));

    expect(mergedPrsTileText()).toBe("996+");
  });

  it("carries a declared whole-cohort count through as a bare number", () => {
    // The control: without it, an adapter that dropped the field entirely would
    // satisfy the undeclared case below and look correct.
    renderPerformanceTab(webAdapterPerformance({ mergedPrsTruncated: false }));

    expect(mergedPrsTileText()).toBe("996");
  });

  it("carries an OMITTED flag through as undeclared, not as a whole-cohort claim", () => {
    const performance = webAdapterPerformance({});
    renderPerformanceTab(performance);

    // The headline alone cannot tell this case from the whole-cohort one above
    // — both print "996", and they differ only in the coverage caveat. So the
    // MAPPED state is asserted too: an adapter folding the omission to `false`
    // (the version-skew defect ISS-6462 exists to prevent) reds here.
    expect(performance.mergedPrsTruncated).toBeUndefined();
    expect(mergedPrsTileText()).toBe("996");
  });
});

/**
 * The `performance` block the web adapter produces for a component payload —
 * the real mapper, from the real wire shape.
 */
function webAdapterPerformance(
  coverage: Partial<Pick<AgentComponentDetail, "mergedPrsTruncated">>
): PackPerformance {
  const component = {
    branchesTab: [],
    branchesTabTruncated: false,
    collaborators: [],
    computeTargetIds: ["ct-1"],
    efficiencyTrend: [],
    firstSeenAt: "2026-07-01T00:00:00Z",
    harness: "claude",
    id: "iss-6462-component",
    invocations: 1284,
    kind: "plugin",
    lastSeenAt: "2026-07-08T00:00:00Z",
    locDelta: null,
    locPerDollar: 3.2,
    mergedPrs: MERGED_PRS_FLOOR,
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
    successDelta: null,
    successRate: null,
    tokenEfficiencyDelta: null,
    trend: [],
    usageSessions: [],
    versions: [],
    ...coverage,
  } as AgentComponentDetail;

  return agentComponentToPackAnalytics(component).performance;
}
