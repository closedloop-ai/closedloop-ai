/**
 * FEA-4017: the desktop agentic-component detail view offers a plain "Install"
 * header action (no compute-target selector — the desktop machine IS the local
 * target) that installs a pack-sourced component onto the local machine via the
 * vetted `desktop:db:catalog-install` IPC (`window.desktopApi.db.catalogInstall`).
 * Any org member can use it: the IPC is a local, sender-gated operation with no
 * org-admin gate.
 *
 * The shared `AgentDetail` is mocked to a marker that invokes its
 * `headerAction` render-prop, so these tests assert the desktop wrapper's
 * install wiring (predicate → IPC call) without a live API/auth/React-Query
 * stack.
 */
import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Feature flag on so the view renders (guarded off returns null).
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => true,
}));

// Detail hook returns whatever the current fixture is.
let currentDetail: AgentComponentDetail;
vi.mock("@repo/app/agents/hooks/use-agent-component-detail", () => ({
  useAgentComponentDetail: () => ({
    data: currentDetail,
    isLoading: false,
    isError: false,
  }),
}));

// Shared AgentDetail → marker that renders the injected headerAction slot,
// exactly as the real component does in DetailHeader.
vi.mock("@repo/app/agents/components/workspace/agent-detail", () => ({
  AgentDetail: ({
    headerAction,
    slug,
    backHref,
  }: {
    headerAction?: (c: AgentComponentDetail) => ReactNode;
    slug: string;
    backHref: string;
  }) => (
    <div data-back-href={backHref} data-slug={slug} data-testid="agent-detail">
      {headerAction?.(currentDetail)}
    </div>
  ),
}));

// The desktop-local analytics panel is out of scope for these tests.
vi.mock("../optimization-analytics-panel", () => ({
  OptimizationAnalyticsPanel: () => <div data-testid="opt-panel" />,
}));

// Topbar breadcrumb publisher — inert.
vi.mock("../../../navigation/detail-title-context", () => ({
  usePublishDetailTitle: () => {
    // no-op
  },
}));

import { AgentDetailView } from "../agent-detail-view";

function makeDetail(
  overrides: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  return {
    id: "uuid-1",
    slug: "skill::rtk",
    name: "RTK",
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Pack,
    source: "RTK",
    harness: Harness.Claude,
    invocations: 1,
    sessions: 1,
    locPerDollar: 1,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    properties: { path: "/skills/rtk.md" },
    prompt: null,
    versions: [],
    resolvedState: ComponentResolvedState.Unresolved,
    sessionsTab: [],
    sessionsTabTruncated: false,
    branchesTab: [],
    branchesTabTruncated: false,
    provenance: [],
    usageSessions: [],
    ...overrides,
  } as AgentComponentDetail;
}

const catalogInstall = vi.fn();

beforeEach(() => {
  catalogInstall.mockReset().mockResolvedValue({ started: true });
  (globalThis as { desktopApi?: unknown }).desktopApi = {
    db: { catalogInstall },
  };
  currentDetail = makeDetail();
});

afterEach(() => {
  (globalThis as { desktopApi?: unknown }).desktopApi = undefined;
  vi.restoreAllMocks();
});

const RE_INSTALL = /^install$/i;
// Honest terminal label: `{ started: true }` only means the run kicked off, so
// the button reads "Install started", never "Installed".
const RE_INSTALL_STARTED = /install started/i;
const RE_INSTALLED_EXACT = /^installed$/i;
const RE_COMPUTE_TARGET = /compute target/i;

describe("AgentDetailView Install action (FEA-4017)", () => {
  it("shows an Install action for a pack-sourced component", () => {
    render(<AgentDetailView agentSlug="skill::rtk" backHref="#" />);
    expect(screen.getByRole("button", { name: RE_INSTALL })).toBeDefined();
  });

  // FEA-3987: the desktop wrapper must thread its own `backHref` into the shared
  // AgentDetail so the not-found / unavailable states render a working back link
  // (the desktop mount passes the Agents-list hash href, not "#").
  it("threads its backHref into the shared AgentDetail", () => {
    render(<AgentDetailView agentSlug="skill::rtk" backHref="#/agents" />);
    expect(
      screen.getByTestId("agent-detail").getAttribute("data-back-href")
    ).toBe("#/agents");
  });

  it("does NOT show an Install action for a non-pack source", () => {
    currentDetail = makeDetail({ sourceType: SourceType.Repo });
    render(<AgentDetailView agentSlug="skill::rtk" backHref="#" />);
    expect(screen.queryByRole("button", { name: RE_INSTALL })).toBeNull();
  });

  it("clicking Install triggers the vetted catalogInstall IPC with the normalized pack id and auto harness", async () => {
    currentDetail = makeDetail({ source: "GStack" });
    render(<AgentDetailView agentSlug="skill::gstack" backHref="#" />);

    fireEvent.click(screen.getByRole("button", { name: RE_INSTALL }));

    await waitFor(() => {
      expect(catalogInstall).toHaveBeenCalledWith("gstack", "auto");
    });
    // Reflects that the run STARTED once resolved — not a claim it finished.
    expect(await screen.findByText(RE_INSTALL_STARTED)).toBeDefined();
    // And never the dishonest "Installed" past-tense.
    expect(screen.queryByText(RE_INSTALLED_EXACT)).toBeNull();
  });

  it("does not render a compute-target selector (desktop machine is the local target)", () => {
    render(<AgentDetailView agentSlug="skill::rtk" backHref="#" />);
    expect(screen.queryByText(RE_COMPUTE_TARGET)).toBeNull();
  });

  it("surfaces an inline error when the install IPC rejects", async () => {
    catalogInstall.mockRejectedValueOnce(new Error("boom"));
    render(<AgentDetailView agentSlug="skill::rtk" backHref="#" />);

    fireEvent.click(screen.getByRole("button", { name: RE_INSTALL }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
  });

  it("does NOT report success when the IPC resolves { started: false } (no throw)", async () => {
    catalogInstall.mockResolvedValueOnce({
      started: false,
      error: { code: "ENOCOMMAND", message: "no install command" },
    });
    render(<AgentDetailView agentSlug="skill::rtk" backHref="#" />);

    fireEvent.click(screen.getByRole("button", { name: RE_INSTALL }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no install command");
    // The button must NOT show the started/success state.
    expect(screen.queryByText(RE_INSTALL_STARTED)).toBeNull();
  });

  it("resets the install action state when the detail view is reused for a different component", async () => {
    // Component A installs; the action shows the "Install started" terminal.
    currentDetail = makeDetail({ slug: "skill::a", source: "A" });
    const { rerender } = render(
      <AgentDetailView agentSlug="skill::a" backHref="#" />
    );
    fireEvent.click(screen.getByRole("button", { name: RE_INSTALL }));
    expect(await screen.findByText(RE_INSTALL_STARTED)).toBeDefined();

    // Navigate to component B in the SAME view (agentSlug + detail change). The
    // action is keyed by component.slug, so it remounts fresh — B must NOT
    // inherit A's "Install started" state.
    currentDetail = makeDetail({ slug: "skill::b", source: "B" });
    rerender(<AgentDetailView agentSlug="skill::b" backHref="#" />);

    expect(screen.queryByText(RE_INSTALL_STARTED)).toBeNull();
    expect(screen.getByRole("button", { name: RE_INSTALL })).toBeDefined();
  });
});
