/**
 * @file plugins-panel.test.tsx
 * @description Unit tests for the desktop PluginsPanel (FEA-2923 / T-16.4;
 * unified Packs UX).
 *
 * Proves the re-skinned pack/plugin management surface still drives the
 * preserved `window.desktopApi.db.catalog*` IPC — these tests would FAIL if the
 * panel were a read-only stub that never loaded the catalog/run-history or never
 * called install/uninstall.
 *
 * The presentational shell (`PacksWorkspace`) is stubbed so the test targets the
 * container's data + IPC contract (which `PackView`s it derives from IPC, and
 * that its callbacks call the right `catalog*` channel with the right harness),
 * without pulling the full `@closedloop-ai/design-system` render graph through
 * `@repo/app`. The real grid/detail rendering is covered by the shared-package
 * component tests.
 */

import type { PackView } from "@repo/app/packs/lib/pack-view";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogEntry,
  InstalledPack,
  InstallRunRecord,
} from "../../../../shared/agent-db-contract";
import { PluginsPanel } from "../plugins-panel";

// Feature-flag hook has no provider in this unit env; pin it deterministically.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
}));

// Lightweight PacksWorkspace stub: renders the derived packs and exposes the
// container's install/uninstall/update/select callbacks as buttons, plus the
// footer slot (run history).
vi.mock("@repo/app/packs/components/packs-workspace", () => ({
  PacksWorkspace: (props: {
    packs: PackView[];
    footerSlot?: React.ReactNode;
    onInstall?: (id: string, harness?: string) => void;
    onUninstall?: (id: string, harness: string) => void;
    onUpdate?: (id: string, harness: string) => void;
  }) => (
    <div data-testid="packs-workspace">
      {props.packs.map((pack) => (
        <div data-testid={`pv-${pack.id}`} key={pack.id}>
          <span>{pack.name}</span>
          <span>{pack.installedByMe ? "installed" : "available"}</span>
          <button onClick={() => props.onInstall?.(pack.id)} type="button">
            install
          </button>
          <button
            onClick={() => props.onInstall?.(pack.id, "codex")}
            type="button"
          >
            install-codex
          </button>
          <button
            onClick={() => props.onUninstall?.(pack.id, "claude")}
            type="button"
          >
            uninstall
          </button>
          <button
            onClick={() => props.onUpdate?.(pack.id, "claude")}
            type="button"
          >
            update
          </button>
        </div>
      ))}
      {props.footerSlot}
    </div>
  ),
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

function makeInstalledPack(over: Partial<InstalledPack> = {}): InstalledPack {
  return {
    packId: "gstack",
    harnesses: ["claude"],
    installs: [],
    skillCount: 0,
    lastSeenAt: null,
    ...over,
  };
}

function makeRun(over: Partial<InstallRunRecord> = {}): InstallRunRecord {
  return {
    id: 1,
    packId: "rtk",
    harness: "claude",
    action: "install",
    command: null,
    exitCode: 0,
    startedAt: "2026-07-11T00:00:00Z",
    endedAt: "2026-07-11T00:01:00Z",
    stdoutTail: null,
    stderrTail: null,
    ...over,
  };
}

type DbMock = {
  getCatalog: ReturnType<typeof vi.fn>;
  getInstalledPacks: ReturnType<typeof vi.fn>;
  getInstallRuns: ReturnType<typeof vi.fn>;
  getCatalogContents: ReturnType<typeof vi.fn>;
  catalogInstall: ReturnType<typeof vi.fn>;
  catalogUninstall: ReturnType<typeof vi.fn>;
};

function installDesktopApi(db: Partial<DbMock>): DbMock {
  const full: DbMock = {
    getCatalog: db.getCatalog ?? vi.fn().mockResolvedValue([]),
    getInstalledPacks: db.getInstalledPacks ?? vi.fn().mockResolvedValue([]),
    getInstallRuns: db.getInstallRuns ?? vi.fn().mockResolvedValue([]),
    getCatalogContents:
      db.getCatalogContents ?? vi.fn().mockResolvedValue(null),
    catalogInstall:
      db.catalogInstall ?? vi.fn().mockResolvedValue({ started: true }),
    catalogUninstall:
      db.catalogUninstall ?? vi.fn().mockResolvedValue({ started: true }),
  };
  (window as unknown as { desktopApi: unknown }).desktopApi = {
    db: full,
    onInstallOutput: vi.fn().mockReturnValue(() => {
      // no-op unsubscribe
    }),
  };
  return full;
}

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
});

describe("PluginsPanel (T-16.4, unified Packs UX)", () => {
  beforeEach(() => {
    // jsdom lacks window.desktopApi; each test installs its own mock.
  });

  it("loads catalog + installed packs from IPC and derives PackViews", async () => {
    const db = installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([
        makeCatalogEntry(),
        makeCatalogEntry({
          packId: "gstack",
          displayName: "GStack",
          description: null,
        }),
      ]),
      getInstalledPacks: vi
        .fn()
        .mockResolvedValue([makeInstalledPack({ packId: "gstack" })]),
    });

    render(<PluginsPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("packs-workspace")).toBeDefined()
    );
    expect(db.getCatalog).toHaveBeenCalledTimes(1);
    expect(db.getInstalledPacks).toHaveBeenCalledTimes(1);
    // gstack is installed (merged from getInstalledPacks); rtk is available.
    expect(
      within(screen.getByTestId("pv-gstack")).getByText("installed")
    ).toBeDefined();
    expect(
      within(screen.getByTestId("pv-rtk")).getByText("available")
    ).toBeDefined();
  });

  it("install (no harness) resolves the pack's first harness for catalogInstall", async () => {
    const db = installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
    });

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-rtk")).toBeDefined());

    fireEvent.click(within(screen.getByTestId("pv-rtk")).getByText("install"));

    await waitFor(() =>
      expect(db.catalogInstall).toHaveBeenCalledWith("rtk", "claude")
    );
  });

  it("install with an explicit harness targets that harness", async () => {
    const db = installDesktopApi({
      getCatalog: vi
        .fn()
        .mockResolvedValue([
          makeCatalogEntry({ harnesses: ["claude", "codex"] }),
        ]),
    });

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-rtk")).toBeDefined());

    fireEvent.click(
      within(screen.getByTestId("pv-rtk")).getByText("install-codex")
    );

    await waitFor(() =>
      expect(db.catalogInstall).toHaveBeenCalledWith("rtk", "codex")
    );
  });

  it("uninstall calls catalogUninstall for the targeted harness", async () => {
    const db = installDesktopApi({
      getCatalog: vi
        .fn()
        .mockResolvedValue([makeCatalogEntry({ packId: "gstack" })]),
      getInstalledPacks: vi
        .fn()
        .mockResolvedValue([makeInstalledPack({ packId: "gstack" })]),
    });

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-gstack")).toBeDefined());

    fireEvent.click(
      within(screen.getByTestId("pv-gstack")).getByText("uninstall")
    );

    await waitFor(() =>
      expect(db.catalogUninstall).toHaveBeenCalledWith("gstack", "claude")
    );
  });

  it("update re-runs catalogInstall (idempotent) for the targeted harness", async () => {
    const db = installDesktopApi({
      getCatalog: vi
        .fn()
        .mockResolvedValue([makeCatalogEntry({ packId: "gstack" })]),
      getInstalledPacks: vi
        .fn()
        .mockResolvedValue([makeInstalledPack({ packId: "gstack" })]),
    });

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-gstack")).toBeDefined());

    fireEvent.click(
      within(screen.getByTestId("pv-gstack")).getByText("update")
    );

    await waitFor(() =>
      expect(db.catalogInstall).toHaveBeenCalledWith("gstack", "claude")
    );
  });

  it("renders run history from getInstallRuns in the footer slot", async () => {
    installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
      getInstallRuns: vi
        .fn()
        .mockResolvedValue([makeRun(), makeRun({ id: 2, exitCode: 1 })]),
    });

    render(<PluginsPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("run-history-list")).toBeDefined()
    );
    expect(screen.getByText("Success")).toBeDefined();
    expect(screen.getByText("Failed (1)")).toBeDefined();
  });

  it("shows an error state when the IPC bridge is unavailable", async () => {
    (window as unknown as { desktopApi?: unknown }).desktopApi = undefined;

    render(<PluginsPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("plugins-error")).toBeDefined()
    );
  });
});
