import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_DOWNLOAD_DESCRIPTION } from "../../../../onboarding/lib/desktop-download-copy";
import {
  DASHBOARD_SCOPE_LABEL,
  SCOPE_TOGGLE_OPTIONS,
} from "../dashboard-scope-copy";
import { InsightsOverviewDashboard } from "../insights-overview-dashboard";
import { withDashboardQueryClient } from "./dashboard-query-client";
import {
  DEGRADED_RE,
  errored,
  NO_SESSIONS_RE,
  sessions,
  succeeded,
  webAgents,
  webDelivery,
  webUtilization,
} from "./dashboard-suite-fixtures";

/**
 * The web Dashboard's Me / Organization control, added by operator instruction
 * (Marisol Ashgrove, 2026-09-30: "We need to also do [PR #8213] this for web; add
 * it in. We can do it as a separate PR") mirroring what PR #8213 restored on
 * desktop for ISS-10929.
 *
 * Three contracts, all of which the desktop suites assert against the desktop
 * shell and none of which that proves for this one, because the two shells mount
 * `useDashboardScope` from different hosts:
 *
 *  - THE GATE: the control renders only where the source advertises `org`
 *    (Marisol Ashgrove, 2026-09-30: "the selector of course should only appear on
 *    desktop if I'm logged in and have 'org' data to display -- otherwise it's
 *    hidden and just shows my local").
 *  - THE CLAMP: with `org` unavailable the effective scope is `Me` whatever the
 *    host asked to start on, so no `org` read leaves a source that cannot serve
 *    one.
 *  - THE DEFAULT: the route mounts this with no `scope`, and personal scope is
 *    what it must then read — on both shells, by operator ruling (Marisol
 *    Ashgrove, 2026-09-30: "both should default to 'Me'"). This route hardcoded
 *    `Org` before that ruling, so the case has to fail if the default drifts
 *    back.
 *
 * Every case asserts the AGENT-SESSIONS read's `viewerScope` alongside the three
 * insights reads, because Recent Sessions follows the same selection through a
 * separate derivation (FEA-3534, `viewerScope` in the component). A regression
 * that unhooked that derivation would leave a KPI-only assertion green — which
 * is the bug FEA-3534 was itself filed to fix.
 */
const hooks = vi.hoisted(() => ({
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  useAgentSessions: vi.fn(),
}));

vi.mock("@repo/app/insights/hooks/use-insights", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/app/insights/hooks/use-insights")
  >()),
  useDeliveryInsights: hooks.useDeliveryInsights,
  useUtilizationInsights: hooks.useUtilizationInsights,
  useAgentsInsights: hooks.useAgentsInsights,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));

vi.mock("../dashboard-rows", () => ({
  DashboardRowContent: ({ row }: { row: { tour: string } }) => (
    <div data-testid={`row-${row.tour}`} />
  ),
}));

vi.mock("@repo/app/agents/components/sessions/synced-sessions-table", () => ({
  SyncedSessionsTable: () => <div data-testid="synced-sessions-table" />,
}));

function createInsightsDataSource(
  availableScopes: readonly InsightsScope[]
): InsightsDataSource {
  return {
    availableScopes: [...availableScopes],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getAgents: () => Promise.reject(new Error("mocked by hook")),
    getDelivery: () => Promise.reject(new Error("mocked by hook")),
    getTileAvailability: () => ({ state: BranchKpiState.Available }),
    getUtilization: () => Promise.reject(new Error("mocked by hook")),
  };
}

function renderDashboard({
  availableScopes,
  scope,
}: {
  availableScopes: readonly InsightsScope[];
  scope?: InsightsScope;
}) {
  return render(
    withDashboardQueryClient(
      <InsightsDataSourceProvider
        value={createInsightsDataSource(availableScopes)}
      >
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <InsightsOverviewDashboard
            emptyStateDescription={DESKTOP_DOWNLOAD_DESCRIPTION}
            getSessionHref={() => "/x"}
            scope={scope}
          />
        </FeatureFlagAdapterProvider>
      </InsightsDataSourceProvider>
    )
  );
}

const scopeControl = () =>
  screen.queryByRole("radiogroup", { name: DASHBOARD_SCOPE_LABEL });

/** The scope every insights query was last driven with (all three share it). */
function lastQueriedScopes() {
  return [
    hooks.useDeliveryInsights,
    hooks.useUtilizationInsights,
    hooks.useAgentsInsights,
  ].map((hook) => hook.mock.calls.at(-1)?.[1]);
}

/**
 * The two `useAgentSessions` reads this component issues, told apart by their
 * params rather than by call order.
 *
 * `at(-1)` is NOT the Recent Sessions read: `useOrgSessionHistory` calls the
 * same hook after it, so the last call is always the `countOnly` existence
 * probe. Both derive `viewerScope` from the same selection, so an order-based
 * assertion passes while pinning the wrong read — and Recent Sessions is the one
 * FEA-3534 is about.
 */
function lastSessionsRead(kind: "recent" | "orgHistory") {
  const wantsCountOnly = kind === "orgHistory";
  return [...hooks.useAgentSessions.mock.calls]
    .reverse()
    .find((call) => Boolean(call[0]?.countOnly) === wantsCountOnly)?.[0];
}

/** The label of the segment for a scope, read from the canonical option list. */
function segmentLabel(scope: InsightsScope) {
  const option = SCOPE_TOGGLE_OPTIONS.find((entry) => entry.value === scope);
  if (!option) {
    throw new Error(`SCOPE_TOGGLE_OPTIONS has no segment for "${scope}".`);
  }
  return option.label;
}

describe("web Dashboard scope control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    hooks.useDeliveryInsights.mockReturnValue(succeeded(webDelivery));
    hooks.useUtilizationInsights.mockReturnValue(succeeded(webUtilization));
    hooks.useAgentsInsights.mockReturnValue(succeeded(webAgents));
    hooks.useAgentSessions.mockReturnValue(sessions(3));
  });

  it("offers both scopes where the source advertises org", () => {
    renderDashboard({
      availableScopes: [InsightsScope.Me, InsightsScope.Org],
      scope: InsightsScope.Org,
    });
    const control = scopeControl();
    expect(control).not.toBeNull();
    expect(
      Array.from(control?.querySelectorAll("button") ?? []).map(
        (button) => button.textContent
      )
    ).toEqual(SCOPE_TOGGLE_OPTIONS.map((option) => option.label));
  });

  it("hides the control when the source advertises only personal scope", () => {
    renderDashboard({ availableScopes: [InsightsScope.Me] });
    expect(scopeControl()).toBeNull();
  });

  it("starts on personal scope the way the route mounts it, with no scope passed", () => {
    renderDashboard({
      availableScopes: [InsightsScope.Me, InsightsScope.Org],
    });
    expect(lastQueriedScopes()).toEqual([
      InsightsScope.Me,
      InsightsScope.Me,
      InsightsScope.Me,
    ]);
    expect(lastSessionsRead("recent")).toMatchObject({
      viewerScope: AgentSessionViewerScope.Self,
    });
  });

  it("starts on a scope the host explicitly seeds", () => {
    renderDashboard({
      availableScopes: [InsightsScope.Me, InsightsScope.Org],
      scope: InsightsScope.Org,
    });
    expect(lastQueriedScopes()).toEqual([
      InsightsScope.Org,
      InsightsScope.Org,
      InsightsScope.Org,
    ]);
    expect(lastSessionsRead("recent")).toMatchObject({
      viewerScope: AgentSessionViewerScope.Organization,
    });
  });

  it("moves the org-wide session read to Organization when the reader picks Org", () => {
    renderDashboard({
      availableScopes: [InsightsScope.Me, InsightsScope.Org],
    });
    fireEvent.click(
      screen.getByRole("radio", { name: segmentLabel(InsightsScope.Org) })
    );
    expect(lastQueriedScopes()).toEqual([
      InsightsScope.Org,
      InsightsScope.Org,
      InsightsScope.Org,
    ]);
    expect(lastSessionsRead("recent")).toMatchObject({
      viewerScope: AgentSessionViewerScope.Organization,
    });
  });

  it("clamps to personal scope when org is not available, whatever the route asked for", () => {
    renderDashboard({
      availableScopes: [InsightsScope.Me],
      scope: InsightsScope.Org,
    });
    expect(lastQueriedScopes()).toEqual([
      InsightsScope.Me,
      InsightsScope.Me,
      InsightsScope.Me,
    ]);
    expect(lastSessionsRead("recent")).toMatchObject({
      viewerScope: AgentSessionViewerScope.Self,
    });
  });

  /**
   * whitlockk, review of #8221: "This is below both early returns, so a user with no
   * personal sessions never gets the switch to Organization even when org data
   * is available. Move the header controls above those returns and cover the
   * Me-empty case."
   *
   * With both shells defaulting to `Me` this is the first-load path for every
   * new or light user, so the empty body is where the control matters MOST.
   * Each case proves the empty (or failed) body is the one rendered before it
   * asserts the control's presence, so a populated page cannot satisfy it.
   */
  it("offers the scope control on the empty body, and switching it reads the org", () => {
    hooks.useAgentSessions.mockReturnValue(sessions(0));
    renderDashboard({
      availableScopes: [InsightsScope.Me, InsightsScope.Org],
    });

    // The empty body is what is drawn, and personal scope is what emptied it.
    expect(screen.getByText(NO_SESSIONS_RE)).toBeInTheDocument();
    expect(lastQueriedScopes()).toEqual([
      InsightsScope.Me,
      InsightsScope.Me,
      InsightsScope.Me,
    ]);

    const control = scopeControl();
    expect(control).not.toBeNull();
    expect(
      Array.from(control?.querySelectorAll("button") ?? []).map(
        (button) => button.textContent
      )
    ).toEqual(SCOPE_TOGGLE_OPTIONS.map((option) => option.label));

    fireEvent.click(
      screen.getByRole("radio", { name: segmentLabel(InsightsScope.Org) })
    );
    expect(lastQueriedScopes()).toEqual([
      InsightsScope.Org,
      InsightsScope.Org,
      InsightsScope.Org,
    ]);
    expect(lastSessionsRead("recent")).toMatchObject({
      viewerScope: AgentSessionViewerScope.Organization,
    });
  });

  it("still hides the control on the empty body when org is not available", () => {
    hooks.useAgentSessions.mockReturnValue(sessions(0));
    renderDashboard({ availableScopes: [InsightsScope.Me] });

    expect(screen.getByText(NO_SESSIONS_RE)).toBeInTheDocument();
    expect(scopeControl()).toBeNull();
  });

  it("offers the scope control on the all-failed body", () => {
    hooks.useDeliveryInsights.mockReturnValue(errored());
    hooks.useUtilizationInsights.mockReturnValue(errored());
    hooks.useAgentsInsights.mockReturnValue(errored());
    renderDashboard({
      availableScopes: [InsightsScope.Me, InsightsScope.Org],
    });

    // The degraded body is what is drawn, not the rows and not the empty state.
    expect(screen.getByText(DEGRADED_RE)).toBeInTheDocument();
    expect(screen.queryByText(NO_SESSIONS_RE)).toBeNull();
    expect(scopeControl()).not.toBeNull();
  });

  it("re-reads every section, sessions included, once the reader picks Me", () => {
    renderDashboard({
      availableScopes: [InsightsScope.Me, InsightsScope.Org],
      scope: InsightsScope.Org,
    });
    expect(lastSessionsRead("recent")).toMatchObject({
      viewerScope: AgentSessionViewerScope.Organization,
    });
    fireEvent.click(
      screen.getByRole("radio", { name: segmentLabel(InsightsScope.Me) })
    );
    expect(lastQueriedScopes()).toEqual([
      InsightsScope.Me,
      InsightsScope.Me,
      InsightsScope.Me,
    ]);
    expect(lastSessionsRead("recent")).toMatchObject({
      viewerScope: AgentSessionViewerScope.Self,
    });
  });
});
