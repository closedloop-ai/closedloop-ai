/**
 * Four branches `agent-detail-view.test.tsx` does not reach:
 * - `analyticsKeyFromSlug`'s `sep === -1 ? slug : slice(...)` (L58) — every
 *   slug in the main suite carries a `kind::key` separator.
 * - The `shortFingerprint` ternary (L167) — `detail.analyticsFingerprint` is
 *   never set there, so only the `undefined` arm runs.
 * - `handleInstall`'s `if (!(api && packId))` (L197) — every case there has
 *   both a real bridge and a resolvable pack id.
 * - The install-rejection fallback `result?.error?.message ?? "Install did
 *   not start."` (L216) — the covered `{ started: false }` case always
 *   carries an `error.message`.
 *
 * `OptimizationAnalyticsPanel` is mocked to a marker that renders its `target`
 * prop so the two analytics-key/fingerprint derivations are observable.
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

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => true,
}));

let currentDetail: AgentComponentDetail;
vi.mock("@repo/app/agents/hooks/use-agent-component-detail", () => ({
  useAgentComponentDetail: () => ({
    data: currentDetail,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@repo/app/agents/components/workspace/agent-detail", () => ({
  AgentDetail: ({
    headerAction,
    analytics,
  }: {
    headerAction?: (c: AgentComponentDetail) => ReactNode;
    analytics?: (c: AgentComponentDetail) => ReactNode;
  }) => (
    <div data-testid="agent-detail">
      {headerAction?.(currentDetail)}
      {analytics?.(currentDetail)}
    </div>
  ),
}));

vi.mock("../optimization-analytics-panel", () => ({
  OptimizationAnalyticsPanel: ({
    target,
  }: {
    target: { key: string; fingerprint?: string; shortFingerprint?: string };
  }) => (
    <div
      data-fingerprint={String(target.fingerprint)}
      data-key={target.key}
      data-short-fingerprint={String(target.shortFingerprint)}
      data-testid="opt-panel"
    />
  ),
}));

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
const RE_INSTALL = /^install$/i;

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

describe("AgentDetailView — analytics key derivation (L58)", () => {
  it("uses the bare slug as the analytics key when it carries no kind:: separator", () => {
    currentDetail = makeDetail({ analyticsKey: undefined });
    render(<AgentDetailView agentSlug="rtk" backHref="#" />);

    expect(screen.getByTestId("opt-panel").dataset.key).toBe("rtk");
  });
});

describe("AgentDetailView — shortFingerprint badge (L167)", () => {
  it("carries no short fingerprint when the read was not content-scoped", () => {
    currentDetail = makeDetail({ analyticsFingerprint: undefined });
    render(<AgentDetailView agentSlug="skill::rtk" backHref="#" />);

    expect(screen.getByTestId("opt-panel").dataset.shortFingerprint).toBe(
      "undefined"
    );
  });

  it("badges the short fingerprint when the read was content-scoped", () => {
    currentDetail = makeDetail({
      analyticsFingerprint: "abc123full",
      fingerprint: "abc123",
    });
    render(<AgentDetailView agentSlug="skill::rtk" backHref="#" />);

    const panel = screen.getByTestId("opt-panel");
    expect(panel.dataset.fingerprint).toBe("abc123full");
    expect(panel.dataset.shortFingerprint).toBe("abc123");
  });
});

describe("AgentDetailView — handleInstall's resolvability guard (L197)", () => {
  it("reports an inline error and never calls the IPC when no bridge is exposed", async () => {
    // The other operand of the guard (`!packId`) is unreachable through the
    // button: `disabled={state === "installing" || !packId}` already refuses
    // the click before `handleInstall` runs, so a falsy `packId` never reaches
    // this branch via the UI. A falsy `api` is the only operand this handler
    // itself can be reached with.
    (globalThis as { desktopApi?: unknown }).desktopApi = undefined;
    render(<AgentDetailView agentSlug="skill::rtk" backHref="#" />);

    fireEvent.click(screen.getByRole("button", { name: RE_INSTALL }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not resolve a pack to install.");
    expect(catalogInstall).not.toHaveBeenCalled();
  });

  it("disables the button outright when the source normalizes to no pack id", () => {
    currentDetail = makeDetail({ source: "" });
    render(<AgentDetailView agentSlug="skill::rtk" backHref="#" />);

    expect(
      (screen.getByRole("button", { name: RE_INSTALL }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});

describe("AgentDetailView — install-failure fallback message (L216)", () => {
  it("falls back to a generic message when the IPC resolves no error detail", async () => {
    catalogInstall.mockResolvedValueOnce({ started: false });
    render(<AgentDetailView agentSlug="skill::rtk" backHref="#" />);

    fireEvent.click(screen.getByRole("button", { name: RE_INSTALL }));

    await waitFor(async () => {
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("Install did not start.");
    });
  });
});
