import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { agentComponentToPackAnalytics } from "../../lib/agent-component-to-analytics";
import type { PackView } from "../../lib/pack-view";
import { mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PackDetail } from "../pack-detail";

/**
 * ISS-6768 — the web Packs detail rendered "Used by (0)" for a pack the desktop
 * Plugins panel showed a populated roster for, because the web adapter
 * hardcoded an empty roster while only the desktop's sibling endpoint carried
 * one.
 *
 * The regression starts one field earlier than a pre-mapped `PackTeamUsage`: at
 * the `AgentComponentDetail` the web surface actually fetches (`usePackAnalytics`
 * → `use-pack-dashboard-selection`), so the adapter is inside the assertion
 * rather than beside it. `PackDetail` is mounted by BOTH shells, so this one
 * mount is the shared render for both; the desktop adapter's own mapping is
 * pinned by `plugin-pack-view.test.ts`.
 */

const CONTEXT = createPacksContext(PacksMode.WebAdmin);
const BASE_PACK = mockPackViews[0];

/** The `teamUsage` block the web adapter produces for a component payload. */
function webAdapterTeamUsage(installers?: readonly string[]) {
  const component = {
    branchesTab: [],
    branchesTabTruncated: false,
    collaborators: ["Maya Chen"],
    computeTargetIds: ["ct-1", "ct-2", "ct-3"],
    efficiencyTrend: [],
    firstSeenAt: "2026-07-01T00:00:00Z",
    harness: "claude",
    id: "iss-6768-component",
    installers,
    invocations: 1284,
    kind: "plugin",
    lastSeenAt: "2026-07-08T00:00:00Z",
    locDelta: null,
    locPerDollar: 3.2,
    mergedPrs: null,
    name: "code",
    prompt: null,
    properties: { format: "md", path: "code" },
    provenance: [],
    qualityDelta: null,
    qualityScore: null,
    resolvedState: "unresolved",
    sessions: 412,
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
  } as AgentComponentDetail;
  if (installers === undefined) {
    Reflect.deleteProperty(component, "installers");
  }
  return agentComponentToPackAnalytics(component).teamUsage;
}

function renderUsageTab(
  installers?: readonly string[],
  installedCount?: number
): void {
  const nav = createMemoryNavigation({
    initialPath: "/packs/code?tab=usage",
    orgSlug: "org-test",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const teamUsage = webAdapterTeamUsage(installers);
  const pack: PackView = {
    ...BASE_PACK,
    teamUsage:
      teamUsage && installedCount !== undefined
        ? { ...teamUsage, installedCount }
        : teamUsage,
  };
  render(<PackDetail context={CONTEXT} pack={pack} />, { wrapper });
}

describe("PackDetail Used By roster, through the web adapter (ISS-6768)", () => {
  it("renders the cloud roster the desktop overlay already showed", () => {
    renderUsageTab(["Rae Okafor", "Jun Watanabe"]);

    expect(screen.getByText("Used by (2)")).toBeInTheDocument();
    expect(screen.getByText("Rae Okafor")).toBeInTheDocument();
    expect(screen.getByText("Jun Watanabe")).toBeInTheDocument();
  });

  it("does not put the version authors in the roster", () => {
    renderUsageTab(["Rae Okafor"]);

    expect(screen.getByText("Used by (1)")).toBeInTheDocument();
    expect(screen.queryByText("Maya Chen")).not.toBeInTheDocument();
  });

  it("says the roster is unavailable when the cloud omits one, never (0)", () => {
    // The version-skew control. This asserted `Used by (0)` until davetho
    // pointed out that it pins the defect rather than the fix: a rolling deploy
    // or a producer that cannot compute the field is not a measured zero, and
    // rendering it as one is the same false zero ISS-6768 exists to remove. The
    // expectation changed because the behavior did — an absent roster now
    // travels as unavailable through `PackTeamUsage` to here.
    renderUsageTab(undefined);

    expect(screen.getByText("Used by")).toBeInTheDocument();
    expect(screen.queryByText("Used by (0)")).not.toBeInTheDocument();
    expect(
      screen.getByText("Roster unavailable for this pack.")
    ).toBeInTheDocument();
  });

  it("renders a measured empty roster as (0)", () => {
    renderUsageTab([]);

    expect(screen.getByText("Used by (0)")).toBeInTheDocument();
    expect(
      screen.queryByText("Roster unavailable for this pack.")
    ).not.toBeInTheDocument();
  });

  it("counts the heading from the exact installer count, not the bounded roster (ISS-9854)", () => {
    // The API caps the name roster at its inventory ceiling but now reports an
    // exact aggregate count beside it. A roster of two names with a count of
    // 5,001 is what a pack past that ceiling looks like on the wire; the heading
    // must read the count, and the roster still lists the names it has.
    renderUsageTab(["Rae Okafor", "Jun Watanabe"], 5001);

    expect(screen.getByText("Used by (5001)")).toBeInTheDocument();
    expect(screen.queryByText("Used by (2)")).not.toBeInTheDocument();
    expect(screen.getByText("Rae Okafor")).toBeInTheDocument();
    expect(screen.getByText("Jun Watanabe")).toBeInTheDocument();
  });
});
