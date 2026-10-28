/**
 * ISS-6643: the desktop half of the Agents component-detail breadcrumb parity
 * pin (rows and rationale: `agent-breadcrumb-honesty-parity.ts`).
 *
 * Every sibling suite in this directory mocks `usePublishDetailTitle` to a
 * no-op, so what this view publishes to the Topbar had no coverage on this
 * surface at all. This file keeps that hook and `DetailTitleProvider` REAL and
 * runs what it publishes through the SAME breadcrumb model `App.tsx` runs —
 * `activeDetailTitleKey` → `resolveDetailTitle` / `resolveDetailTitleSettled`
 * → `buildBreadcrumbs` — so the assertions are on the trailing crumb the
 * Topbar would actually be handed, not on a raw published title.
 *
 * That last hop is load-bearing, not scope creep (whitlockk review on PR #5927).
 * `App.tsx` adopts a published title ONLY when its key equals the route key
 * `activeDetailTitleKey` derives for the shown slug (`agent:<slug>`). A probe
 * that read `published.title` directly would treat ANY published title as the
 * crumb, so misspelling the publish key would leave the real Topbar on its
 * fallback while the probe stayed green — the exact regression this file
 * exists to catch. Resolving against the route key is what makes a wrong key
 * fail here.
 *
 * The flag is PINNED EXPLICITLY in both states, which matters more than usual
 * here: an unpinned flag resolves disabled (ISS-5487), so "the name shows"
 * would pass for the wrong reason — desktop shows the name because it never
 * reads the flag, not because the flag is on. Asserting the SAME output under
 * both pins is what turns that into a claim. The mocked module is the one a
 * desktop gate would have to read (`App.tsx`, `use-nav-gates.ts` and the shared
 * `AgentDetail` all read it), so gating the publish reddens this file.
 */

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { makeDetail } from "@repo/app/agents/components/workspace/agent-component-fixtures";
import { AGENT_BREADCRUMB_HONESTY_PARITY } from "@repo/app/agents/lib/agent-breadcrumb-honesty-parity";
import { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { detailMock, featureFlagEnabledMock } = vi.hoisted(() => ({
  detailMock: vi.fn(),
  featureFlagEnabledMock: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-agent-component-detail", () => ({
  useAgentComponentDetail: detailMock,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (flag: string) => featureFlagEnabledMock(flag),
  useFeatureFlagEnabledOptional: (flag: string) => featureFlagEnabledMock(flag),
}));

// The shared body is not what this file is about — the sibling
// `agents-view-parity.test.tsx` renders it for real. Marker keeps the mount off
// the React-Query/data-source graph so the Topbar publish is the only subject.
vi.mock("@repo/app/agents/components/workspace/agent-detail", () => ({
  AgentDetail: () => <div data-testid="agent-detail" />,
}));

// Reads `window.desktopApi.db` IPC; out of scope, stubbed exactly as the
// siblings stub it.
vi.mock("../optimization-analytics-panel", () => ({
  OptimizationAnalyticsPanel: () => <div data-testid="opt-panel" />,
}));

import {
  activeDetailTitleKey,
  buildBreadcrumbs,
} from "../../../navigation/breadcrumb-model";
import {
  DetailTitleProvider,
  resolveDetailTitle,
  resolveDetailTitleSettled,
  useDetailTitle,
} from "../../../navigation/detail-title-context";
import { NavId } from "../../../navigation/route-table";
import { AgentDetailView } from "../agent-detail-view";

const PARITY = AGENT_BREADCRUMB_HONESTY_PARITY;
const TOPBAR_TRAIL = "topbar-trail";
/** Only reached if the model returned no segments — a detail route always does. */
const NO_CRUMB = "";
const TRAIL_SEPARATOR = " / ";
const AGENTS_LIST_HREF = "/agents";
/** The parent segment `buildBreadcrumbs` puts ahead of an agent detail's name. */
const AGENTS_PARENT_CRUMB = "Agents";

/**
 * Stands in for the AppShell Topbar, running the exact wiring `App.tsx` runs
 * (see this file's header): the published title is adopted only when its key
 * matches the route key derived from the SHOWN slug, and the trailing segment
 * is whatever the model puts there — the resolved name, the pending label, or
 * the placeholder noun.
 *
 * The non-agent inputs are the null/list values `App.tsx` passes on an agent
 * route; `buildBreadcrumbs` takes its agent branch before reading them.
 */
function TopbarCrumbProbe() {
  const published = useDetailTitle();
  const activeKey = activeDetailTitleKey(null, null, PARITY.hashSlug);
  const crumbs = buildBreadcrumbs({
    agentsListHref: AGENTS_LIST_HREF,
    branchBackHref: AGENTS_LIST_HREF,
    branchBackLabel: BranchBackLabel.Branches,
    detailAgentSlug: PARITY.hashSlug,
    detailBranchId: null,
    detailSessionId: null,
    detailTitle: resolveDetailTitle(published, activeKey),
    detailTitleSettled: resolveDetailTitleSettled(published, activeKey),
    navId: NavId.Agents,
    sessionsListHref: AGENTS_LIST_HREF,
  });
  return (
    <span data-testid={TOPBAR_TRAIL}>
      {crumbs.map((crumb) => crumb.label).join(TRAIL_SEPARATOR)}
    </span>
  );
}

/**
 * Mount the real desktop detail view under a pinned flag state and return the
 * breadcrumb labels the Topbar would be handed.
 */
function desktopTrailUnder(honestyFlag: boolean): string[] {
  featureFlagEnabledMock.mockImplementation(
    (flag: string) => flag === PARITY.flagKey && honestyFlag
  );

  const { unmount } = render(
    <DetailTitleProvider>
      <AgentDetailView agentSlug={PARITY.hashSlug} backHref="#/agents" />
      <TopbarCrumbProbe />
    </DetailTitleProvider>
  );
  const trail = (screen.getByTestId(TOPBAR_TRAIL).textContent ?? NO_CRUMB)
    .split(TRAIL_SEPARATOR)
    .filter((label) => label !== NO_CRUMB);
  unmount();
  return trail;
}

/** The name slot: the last segment of the trail. */
function desktopCrumbUnder(honestyFlag: boolean): string {
  return desktopTrailUnder(honestyFlag).at(-1) ?? NO_CRUMB;
}

describe("ISS-6643: agent detail breadcrumb honesty, desktop vs web", () => {
  beforeEach(() => {
    featureFlagEnabledMock.mockReset();
    detailMock.mockReset();
    detailMock.mockReturnValue({
      data: makeDetail({
        name: PARITY.componentName,
        slug: PARITY.hashSlug,
      }) satisfies AgentComponentDetail,
      isLoading: false,
      isError: false,
    });
  });

  // Catches desktop being converged DOWN to web (gating the publish): the
  // flag-off crumb falls to the model's loading/placeholder slot and stops
  // matching the pinned desktop row. It equally catches the publish key
  // drifting off `agent:<slug>`, which strands the real Topbar on that same
  // fallback.
  it("renders the resolved name as the Topbar's trailing crumb with the honesty flag pinned OFF, where web shows the neutral fallback", () => {
    const crumb = desktopCrumbUnder(false);

    expect(crumb).toBe(PARITY.flagOff.desktop);
    // The divergence itself, read off ONE rendered desktop screen: what web
    // renders from this same component and this same pinned flag state is not
    // what desktop renders.
    expect(crumb).not.toBe(PARITY.flagOff.web);
  });

  // Catches the desktop publish becoming flag-dependent in EITHER direction:
  // the two pinned states would stop producing the same crumb. Without both
  // states the flag-off assertion above would pass for the wrong reason —
  // an unpinned flag resolves disabled (ISS-5487).
  it("renders the same crumb with the flag pinned ON — the desktop crumb never reads the honesty flag", () => {
    const off = desktopCrumbUnder(false);
    const on = desktopCrumbUnder(true);

    expect(on).toBe(PARITY.flagOn.desktop);
    expect(on).toBe(off);
  });

  // The trail, not just its tail: the name has to land in the NAME slot of the
  // two-segment "Agents / <name>" model. A published title the model drops (a
  // key that no longer matches the route key) cannot satisfy this, and neither
  // can a name that arrives without its parent segment.
  it("puts the name in the Topbar's name slot, behind the Agents parent segment", () => {
    expect(desktopTrailUnder(false)).toEqual([
      AGENTS_PARENT_CRUMB,
      PARITY.flagOff.desktop,
    ]);
  });
});
