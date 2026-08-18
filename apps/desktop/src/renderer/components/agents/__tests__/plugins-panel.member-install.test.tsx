/**
 * @file plugins-panel.member-install.test.tsx
 * @description Coverage for the ISS-5125 member install ACT half on the DESKTOP
 * adapter.
 *
 * The web and desktop surfaces render the same `MemberTargetsBlock` but dispatch
 * through completely different transports: web POSTs the FEA-4082 cloud route,
 * while desktop's cells are the synthetic local machine and must run this
 * panel's existing vetted LOCAL catalog install. That divergence is exactly what
 * a shared-component change can get wrong silently, so the desktop half is
 * asserted here rather than inferred from the web tests.
 *
 * The three things proven: the affordance is absent while the shared flag is
 * off, it dispatches `catalogInstall` (never a cloud call) when on, and its
 * pending cell is keyed to `LOCAL_MACHINE_TARGET_ID` so the spinner lands on the
 * local row.
 */

import type { MemberTargetsInstall } from "@repo/app/packs/components/member-targets-block";
import { memberInstallCellKey } from "@repo/app/packs/components/member-targets-block";
import { LOCAL_MACHINE_TARGET_ID } from "@repo/app/packs/lib/member-targets";
import type { PackView } from "@repo/app/packs/lib/pack-view";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry } from "../../../../shared/agent-db-contract";
import { PluginsPanel } from "../plugins-panel";

// The shared flag is read through the feature-flag port, which has no provider
// in this unit env. `memberInstallFlag` is what each test flips.
const memberInstallFlag = { enabled: false };

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => memberInstallFlag.enabled,
  useFeatureFlagEnabledOptional: () => memberInstallFlag.enabled,
}));

// Captures the `memberTargetsInstall` handle the container passes down, so the
// test can drive the real dispatch rather than assert on a rendered button that
// the stubbed workspace would have to reimplement.
const captured: { install?: MemberTargetsInstall | null } = {};

vi.mock("@repo/app/packs/components/packs-workspace", () => ({
  PacksWorkspace: (props: {
    packs: PackView[];
    memberTargetsInstall?: MemberTargetsInstall | null;
    onSelectPack?: (packId: string | null) => void;
  }) => {
    captured.install = props.memberTargetsInstall;
    return (
      <div data-testid="packs-workspace">
        <span data-testid="has-install">
          {props.memberTargetsInstall ? "act" : "read-only"}
        </span>
        {props.packs.map((pack) => (
          <button
            key={pack.id}
            onClick={() => props.onSelectPack?.(pack.id)}
            type="button"
          >
            {`select-${pack.id}`}
          </button>
        ))}
      </div>
    );
  },
}));

function makeCatalogEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    packId: "rtk",
    displayName: "RTK",
    category: null,
    githubUrl: "https://example.com",
    marketplaceUrl: null,
    description: "Rust Token Killer",
    descriptionLive: null,
    harnesses: ["claude"],
    installCommands: null,
    uninstallCommands: null,
    installNotes: null,
    placeholderReason: null,
    verified: true,
    readmeExcerpt: null,
    stars: null,
    forks: null,
    lastRelease: null,
    seedVersion: 1,
    pinOrder: null,
    contents: null,
    contentsCache: null,
    detectionPatterns: null,
    harnessAgnostic: false,
    projectScoped: false,
    singleInstall: false,
    postInstall: null,
    installedHarnesses: [],
    skillCount: 0,
    usageCount: 0,
    history: [],
    ...over,
  };
}

function installDesktopApi(catalogInstallImpl?: ReturnType<typeof vi.fn>) {
  const catalogInstall =
    catalogInstallImpl ?? vi.fn().mockResolvedValue({ started: true });
  (window as unknown as { desktopApi: unknown }).desktopApi = {
    db: {
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
      getInstalledPacks: vi.fn().mockResolvedValue([]),
      getInstallRuns: vi.fn().mockResolvedValue([]),
      getCatalogContents: vi.fn().mockResolvedValue(null),
      catalogInstall,
      catalogUninstall: vi.fn().mockResolvedValue({ started: true }),
    },
    onInstallOutput: vi.fn().mockReturnValue(() => {
      // no-op unsubscribe
    }),
  };
  return catalogInstall;
}

afterEach(() => {
  vi.restoreAllMocks();
  memberInstallFlag.enabled = false;
  captured.install = undefined;
  (window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
});

describe("PluginsPanel member install affordance (ISS-5125, desktop)", () => {
  it("passes no install handle while the shared flag is off", async () => {
    memberInstallFlag.enabled = false;
    installDesktopApi();

    render(<PluginsPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("packs-workspace")).toBeDefined()
    );

    expect(screen.getByTestId("has-install").textContent).toBe("read-only");
    expect(captured.install).toBeNull();
  });

  it("dispatches the LOCAL catalog install — not a cloud member-install — when the flag is on", async () => {
    memberInstallFlag.enabled = true;
    const catalogInstall = installDesktopApi();

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByText("select-rtk")).toBeDefined());
    fireEvent.click(screen.getByText("select-rtk"));

    await waitFor(() => expect(captured.install).not.toBeNull());
    captured.install?.onInstall({
      computeTargetId: LOCAL_MACHINE_TARGET_ID,
      computeTargetName: "This machine",
      harness: "claude",
      action: "install",
    });

    // The vetted local IPC install, with the harness the clicked row belongs to.
    await waitFor(() =>
      expect(catalogInstall).toHaveBeenCalledWith("rtk", "claude")
    );
  });

  it("keys the in-flight cell to the local machine so the spinner lands on that row", async () => {
    memberInstallFlag.enabled = true;
    // Held open deliberately: `runMutation` clears `pending` in a `finally`, so
    // an instantly-resolving install would clear the in-flight state before it
    // could be observed and the assertion would prove nothing.
    let releaseInstall: () => void = () => {
      // replaced synchronously below
    };
    const held = new Promise<{ started: boolean }>((resolve) => {
      releaseInstall = () => resolve({ started: true });
    });
    installDesktopApi(vi.fn().mockReturnValue(held));

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByText("select-rtk")).toBeDefined());
    fireEvent.click(screen.getByText("select-rtk"));

    await waitFor(() => expect(captured.install).not.toBeNull());
    captured.install?.onInstall({
      computeTargetId: LOCAL_MACHINE_TARGET_ID,
      computeTargetName: "This machine",
      harness: "claude",
      action: "install",
    });

    await waitFor(() =>
      expect(captured.install?.pendingCellKeys).toStrictEqual([
        memberInstallCellKey(LOCAL_MACHINE_TARGET_ID, "claude"),
      ])
    );

    // Released so the panel settles rather than leaving a dangling promise.
    releaseInstall();
    await waitFor(() =>
      expect(captured.install?.pendingCellKeys).toStrictEqual([])
    );
  });

  it("surfaces a RESOLVED preflight refusal ({ started: false }) as a retryable cell outcome", async () => {
    // The vetted catalog IPC does not throw for an ordinary refusal — no
    // install command for the harness, an unsupported target — it RESOLVES
    // `{ started: false, error }`. Reading only the `catch` cleared the spinner
    // and left the cell with no failure and no Retry, so the member was told
    // nothing at all about an install that never began.
    memberInstallFlag.enabled = true;
    installDesktopApi(
      vi.fn().mockResolvedValue({
        started: false,
        error: { code: "ENOCOMMAND", message: "no install command" },
      })
    );

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByText("select-rtk")).toBeDefined());
    fireEvent.click(screen.getByText("select-rtk"));

    await waitFor(() => expect(captured.install).not.toBeNull());
    captured.install?.onInstall({
      computeTargetId: LOCAL_MACHINE_TARGET_ID,
      computeTargetName: "This machine",
      harness: "claude",
      action: "install",
    });

    const key = memberInstallCellKey(LOCAL_MACHINE_TARGET_ID, "claude");
    await waitFor(() =>
      expect(captured.install?.dispatchByCellKey?.[key]).toBeDefined()
    );
    const outcome = captured.install?.dispatchByCellKey?.[key];
    expect(outcome?.message).toContain("no install command");
    // A local preflight refusal IS provably terminal — nothing was queued
    // anywhere — so unlike the cloud path's unconfirmed failures it may retry.
    expect(outcome?.retryable).toBe(true);
    expect(captured.install?.pendingCellKeys).toStrictEqual([]);
  });

  it("reports a started install with no outcome line — the positive control", async () => {
    // Pairs with the assertion above: the same selector must be EMPTY when the
    // IPC actually starts the install, or "an error appeared" would prove
    // nothing about `started` being read.
    memberInstallFlag.enabled = true;
    installDesktopApi(vi.fn().mockResolvedValue({ started: true, runId: 7 }));

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByText("select-rtk")).toBeDefined());
    fireEvent.click(screen.getByText("select-rtk"));

    await waitFor(() => expect(captured.install).not.toBeNull());
    captured.install?.onInstall({
      computeTargetId: LOCAL_MACHINE_TARGET_ID,
      computeTargetName: "This machine",
      harness: "claude",
      action: "install",
    });

    await waitFor(() =>
      expect(captured.install?.pendingCellKeys).toStrictEqual([])
    );
    const key = memberInstallCellKey(LOCAL_MACHINE_TARGET_ID, "claude");
    expect(captured.install?.dispatchByCellKey?.[key]).toBeUndefined();
  });
});
