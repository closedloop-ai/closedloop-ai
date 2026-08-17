/**
 * @file member-packs-view.test.tsx
 * @description Behavioral tests for the desktop-member Packs adapter (FEA-4166).
 *
 * FEA-4089 (#3752) shipped the WEB member by-source treatment; desktop still
 * mounted the flat `PluginsPanel` for the member slot, so the two surfaces of
 * the same product diverged. `DesktopMemberPacksView` closes that gap by
 * mounting the shared `MemberView` on the desktop member slot, fed from the
 * desktop data ports.
 *
 * These tests assert the adapter's contract, not the shared view's internals
 * (`member-view.test.tsx` covers those): it renders the grouped by-source
 * "Your packs" treatment (Required / Installed regions) rather than the flat
 * PluginsPanel list; it threads the desktop `memberUserId` through so a
 * `specific` distribution scopes to the targeted cohort; and it preserves the
 * functional `PluginsPanel` as the Available slot (the local install surface).
 * The shared data hook + auth snapshot are mocked so the test drives the
 * production render path without a live cloud API.
 */

import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import type { PackView } from "@repo/app/packs/lib/pack-view";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopMemberPacksView } from "../member-packs-view";

const useAdminPackViewsMock = vi.fn();
const useAuthSnapshotMock = vi.fn();

vi.mock("@repo/app/packs/hooks/use-admin-pack-views", () => ({
  useAdminPackViews: () => useAdminPackViewsMock(),
}));

vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => ({
  useAuthSnapshot: () => useAuthSnapshotMock(),
}));

// The Available slot is the real local install surface. Stub it so the adapter
// test targets the by-source wiring, not the panel's own IPC contract
// (plugins-panel.test.tsx covers that).
vi.mock("../../agents/plugins-panel", () => ({
  PluginsPanel: () => <div data-testid="plugins-panel" />,
}));

function pack(overrides: Partial<PackView> = {}): PackView {
  return {
    id: "pack-1",
    name: "Security Baseline",
    publisher: "Platform Eng",
    version: "4.2.0",
    description: "Org security gates",
    verified: false,
    harnesses: [],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
    distribution: null,
    performance: null,
    ...overrides,
  };
}

function setAuth(userId: string | null): void {
  useAuthSnapshotMock.mockReturnValue({
    isLoaded: true,
    userId,
    orgId: "org-1",
    getToken: () => Promise.resolve(null),
  });
}

function setPackViews(
  packViews: PackView[],
  extra: { isLoading?: boolean; error?: Error | null } = {}
): void {
  useAdminPackViewsMock.mockReturnValue({
    packViews,
    distributionByCatalogId: new Map(),
    distributedRows: [],
    isLoading: extra.isLoading ?? false,
    error: extra.error ?? null,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DesktopMemberPacksView (FEA-4166)", () => {
  it("renders the shared by-source MemberView (grouped Your packs), not the flat PluginsPanel list", () => {
    setAuth("member-me");
    setPackViews([
      pack({
        id: "req",
        name: "Security Baseline",
        distribution: {
          id: "dist-1",
          mode: DistributionMode.AutoInstall,
          targetingType: DistributionTargetingType.All,
          desiredEnabled: true,
          targetCount: 1,
          installedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          targetingEntries: [],
          adoptionLoaded: true,
        },
      }),
    ]);

    render(<DesktopMemberPacksView />);

    // The by-source treatment: a "Your packs" region grouped Required, with the
    // pack rendered inside it — this is the web treatment, not the flat list.
    const yourPacks = screen.getByRole("region", { name: "Your packs" });
    expect(yourPacks).toBeDefined();
    expect(screen.getByText("Required by your org")).toBeDefined();
    expect(within(yourPacks).getByText("Security Baseline")).toBeDefined();
  });

  it("preserves the functional PluginsPanel as the Available slot (local install surface kept)", () => {
    setAuth("member-me");
    setPackViews([pack({ id: "req" })]);

    render(<DesktopMemberPacksView />);

    const available = screen.getByRole("region", { name: "Available" });
    expect(within(available).getByTestId("plugins-panel")).toBeDefined();
  });

  it("scopes a specific auto_install distribution to the desktop member — an untargeted member doesn't see it as Required", () => {
    setAuth("member-me");
    setPackViews([
      pack({
        id: "targeted-elsewhere",
        name: "Locale Pack",
        distribution: {
          id: "dist-2",
          mode: DistributionMode.AutoInstall,
          targetingType: DistributionTargetingType.Specific,
          desiredEnabled: true,
          targetCount: 1,
          installedCount: 0,
          pendingCount: 0,
          failedCount: 0,
          targetingEntries: [{ computeTargetId: null, userId: "someone-else" }],
          adoptionLoaded: true,
        },
      }),
    ]);

    render(<DesktopMemberPacksView />);

    // Not required for this member: no Required heading, and the pack does not
    // appear in the "Your packs" region — it degrades to Available (whose body is
    // the PluginsPanel slot here) rather than mislabelling every member's row.
    expect(screen.queryByText("Required by your org")).toBeNull();
    const yourPacks = screen.getByRole("region", { name: "Your packs" });
    expect(within(yourPacks).queryByText("Locale Pack")).toBeNull();
  });

  it("renders an honest error state, never a misleading empty, when the catalog read fails", () => {
    setAuth("member-me");
    setPackViews([], { error: new Error("boom") });

    render(<DesktopMemberPacksView />);

    expect(screen.getByText("Couldn't load packs")).toBeDefined();
    expect(screen.queryByText("No packs yet")).toBeNull();
  });

  it("keeps the local PluginsPanel install surface mounted when the cloud catalog read fails (signed out / offline)", () => {
    // Regression (FEA-4166): DesktopAppCoreMode.Local has no usable cloud auth,
    // so the shared cloud hook's `/catalog` + `/distributions` reads fail. The
    // Available slot here is the fully-local `window.desktopApi.db` install
    // surface — it needs no cloud, so a failed cloud read must surface only in
    // the "Your packs" region and NOT unmount the local install/uninstall panel,
    // which was the whole capability the flat PluginsPanel mount provided before.
    setAuth(null);
    setPackViews([], { error: new Error("catalog fetch failed (offline)") });

    render(<DesktopMemberPacksView />);

    // The cloud error is surfaced once, in the primary region…
    expect(screen.getByText("Couldn't load packs")).toBeDefined();
    // …and the local install surface stays mounted in Available.
    const available = screen.getByRole("region", { name: "Available" });
    expect(within(available).getByTestId("plugins-panel")).toBeDefined();
  });

  it("renders the loading skeleton while the catalog read is in flight", () => {
    setAuth("member-me");
    setPackViews([], { isLoading: true });

    render(<DesktopMemberPacksView />);

    expect(screen.getByTestId("member-packs-skeleton")).toBeDefined();
  });
});
