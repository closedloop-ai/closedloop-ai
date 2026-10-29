/**
 * @description ISS-11284 branch-coverage tests for `PluginsPanel`.
 *
 * Targets branches not exercised by the sibling `plugins-panel*.test.tsx`
 * files: the IPC-bridge-missing early return in `runMutation`, the
 * `catalogInstall`/`catalogUninstall` resolved-refusal message fallback, the
 * `resolveHarness` default fallback, the member-install `onInstall` no-op
 * when nothing is selected, the analytics overlay's null/present branches,
 * and the run-history harness-label conditional.
 */

import type { PackView } from "@repo/app/packs/lib/pack-view";
import { MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogEntry,
  InstalledPack,
  InstallRunRecord,
} from "../../../../shared/agent-db-contract";
import { PluginsPanel } from "../plugins-panel";

const memberInstallFlag = { enabled: false };

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: (key: string) =>
    key === MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY
      ? memberInstallFlag.enabled
      : false,
  useFeatureFlagGateOptional: () => ({
    enabled: false,
    isReady: true,
    isResolved: true,
  }),
}));

vi.mock("@repo/app/packs/components/packs-workspace", () => ({
  PacksWorkspace: (props: {
    packs: PackView[];
    detailPack?: PackView | null;
    detailContentsUnavailable?: boolean;
    installError?: string | null;
    memberTargetsInstall?: {
      onInstall: (args: { harness: string }) => void;
    } | null;
    footerSlot?: ReactNode;
    onInstall?: (id: string, harness?: string) => void;
    onUninstall?: (id: string, harness: string) => void;
    onSelectPack?: (id: string | null) => void;
  }) => (
    <div data-testid="packs-workspace">
      <div data-testid="detail-contents-unavailable">
        {String(props.detailContentsUnavailable)}
      </div>
      {props.detailPack?.performance ? (
        <div data-testid="detail-invocations">
          {props.detailPack.performance.invocations}
        </div>
      ) : null}
      {props.detailPack?.teamUsage ? (
        <div data-testid="detail-device-count">
          {props.detailPack.teamUsage.deviceCount}
        </div>
      ) : null}
      {props.installError ? (
        <div data-testid="install-error">{props.installError}</div>
      ) : null}
      {props.packs.map((pack) => (
        <div data-testid={`pv-${pack.id}`} key={pack.id}>
          <span>{pack.name}</span>
          <button onClick={() => props.onSelectPack?.(pack.id)} type="button">
            select-{pack.id}
          </button>
          <button onClick={() => props.onInstall?.(pack.id)} type="button">
            install-{pack.id}
          </button>
        </div>
      ))}
      <button
        data-testid="member-install"
        onClick={() =>
          props.memberTargetsInstall?.onInstall({ harness: "claude" })
        }
        type="button"
      >
        member-install
      </button>
      {props.footerSlot}
    </div>
  ),
}));

function renderWithNav(ui: ReactElement) {
  const nav = createMemoryNavigation({ initialPath: "/packs" });
  return render(
    <NavigationProvider adapter={nav.adapter}>{ui}</NavigationProvider>
  );
}

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

type DbMock = Record<string, ReturnType<typeof vi.fn>>;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installDesktopApi(
  db: Partial<DbMock>,
  onInstallOutput?: ReturnType<typeof vi.fn>
): DbMock {
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
    getPackAnalytics: db.getPackAnalytics ?? vi.fn().mockResolvedValue(null),
    getPackDetail: db.getPackDetail ?? vi.fn().mockResolvedValue(null),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    writable: true,
    value: {
      db: full,
      onInstallOutput:
        onInstallOutput ??
        vi.fn().mockReturnValue(() => {
          // no-op unsubscribe
        }),
    },
  });
  return full;
}

afterEach(() => {
  vi.restoreAllMocks();
  memberInstallFlag.enabled = false;
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("PluginsPanel coverage — runMutation IPC-bridge-missing branch", () => {
  it("no-ops an install click when window.desktopApi.db is unavailable mid-session", async () => {
    const db = installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
    });
    renderWithNav(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-rtk")).toBeDefined());

    // Pull the bridge out from under the mounted panel (e.g. a stale preload).
    (window as unknown as { desktopApi: unknown }).desktopApi = {
      db: undefined,
      onInstallOutput: vi.fn().mockReturnValue(() => {
        // no-op
      }),
    };

    fireEvent.click(screen.getByText("install-rtk"));

    // catalogInstall on the ORIGINAL db mock must never fire — the early
    // return in `runMutation` took effect synchronously instead of throwing.
    expect(db.catalogInstall).not.toHaveBeenCalled();
    expect(screen.queryByTestId("install-error")).toBeNull();
  });
});

describe("PluginsPanel coverage — resolved-refusal error fallback", () => {
  it("uses the refusal's error message when present", async () => {
    installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
      catalogInstall: vi.fn().mockResolvedValue({
        started: false,
        error: { message: "no install command for harness" },
      }),
    });
    renderWithNav(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-rtk")).toBeDefined());

    fireEvent.click(screen.getByText("install-rtk"));

    const error = await screen.findByTestId("install-error");
    expect(error.textContent).toBe("no install command for harness");
  });

  it("falls back to a generic message when the refusal carries no error", async () => {
    installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
      catalogInstall: vi.fn().mockResolvedValue({ started: false }),
    });
    renderWithNav(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-rtk")).toBeDefined());

    fireEvent.click(screen.getByText("install-rtk"));

    const error = await screen.findByTestId("install-error");
    expect(error.textContent).toBe("Could not install plugin.");
  });
});

describe("PluginsPanel coverage — install-output subscription", () => {
  it("reloads the catalog when a run completes, and ignores non-complete chunks", async () => {
    let outputHandler: ((chunk: { type: string }) => void) | undefined;
    const onInstallOutput = vi.fn(
      (handler: (chunk: { type: string }) => void) => {
        outputHandler = handler;
        return () => {
          // no-op unsubscribe
        };
      }
    );
    const db = installDesktopApi(
      { getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]) },
      onInstallOutput
    );
    renderWithNav(<PluginsPanel />);
    await waitFor(() => expect(db.getCatalog).toHaveBeenCalledTimes(1));

    // Non-"complete" chunk: does not trigger a reload (false branch) — the
    // check is synchronous, so no wait is needed to observe it.
    act(() => {
      outputHandler?.({ type: "stdout" });
    });
    expect(db.getCatalog).toHaveBeenCalledTimes(1);

    // "complete" chunk: triggers a reload (true branch).
    act(() => {
      outputHandler?.({ type: "complete" });
    });
    await waitFor(() => expect(db.getCatalog).toHaveBeenCalledTimes(2));
  });
});

describe("PluginsPanel coverage — run history load failure", () => {
  it("leaves run history empty when getInstallRuns rejects", async () => {
    installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
      getInstallRuns: vi.fn().mockRejectedValue(new Error("boom")),
    });
    renderWithNav(<PluginsPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("run-history-empty")).toBeDefined()
    );
  });

  it("renders a harness suffix only when the run recorded one", async () => {
    installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
      getInstallRuns: vi
        .fn()
        .mockResolvedValue([makeRun({ harness: null as unknown as string })]),
    });
    renderWithNav(<PluginsPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("run-history-list")).toBeDefined()
    );
    expect(screen.getByText("install · rtk")).toBeDefined();
  });
});

describe("PluginsPanel coverage — member install target block", () => {
  afterEach(() => {
    memberInstallFlag.enabled = false;
  });

  it("no-ops the member-install dispatch when no pack is selected", async () => {
    memberInstallFlag.enabled = true;
    const db = installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
    });
    renderWithNav(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-rtk")).toBeDefined());

    fireEvent.click(screen.getByTestId("member-install"));

    expect(db.catalogInstall).not.toHaveBeenCalled();
  });

  it("dispatches the member-install through runMutation once a pack is selected", async () => {
    memberInstallFlag.enabled = true;
    const db = installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
    });
    renderWithNav(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-rtk")).toBeDefined());

    fireEvent.click(screen.getByText("select-rtk"));
    fireEvent.click(screen.getByTestId("member-install"));

    await waitFor(() =>
      expect(db.catalogInstall).toHaveBeenCalledWith("rtk", "claude")
    );
  });
});

describe("PluginsPanel coverage — resolveHarness fallback", () => {
  it("falls back to the DEFAULT_HARNESS when the pack lists none and no harness is given", async () => {
    const db = installDesktopApi({
      getCatalog: vi
        .fn()
        .mockResolvedValue([makeCatalogEntry({ harnesses: [] })]),
    });
    renderWithNav(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-rtk")).toBeDefined());

    fireEvent.click(screen.getByText("install-rtk"));

    await waitFor(() =>
      expect(db.catalogInstall).toHaveBeenCalledWith("rtk", "claude")
    );
  });
});

describe("PluginsPanel coverage — analytics overlay resolution", () => {
  it("overlays the resolved analytics onto the selected detail pack", async () => {
    const analytics = {
      owners: ["alice"],
      locPerDollar: 1,
      locDelta: 0,
      successRate: 1,
      successDelta: 0,
      tokenEfficiencyDelta: 0,
      efficiencyTrend: [],
      invocations: 37,
      sessions: 1,
      mergedPrs: 1,
      mergedPrsTruncated: undefined,
      baselineSampleSize: undefined,
      qualityScore: null,
      qualityDelta: null,
      installerCount: 1,
      deviceCount: 5,
    } as unknown;
    const db = installDesktopApi({
      getCatalog: vi
        .fn()
        .mockResolvedValue([makeCatalogEntry({ packId: "gstack" })]),
      getInstalledPacks: vi
        .fn()
        .mockResolvedValue([makeInstalledPack({ packId: "gstack" })]),
      getPackAnalytics: vi.fn().mockResolvedValue(analytics),
    });
    renderWithNav(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-gstack")).toBeDefined());

    expect(screen.queryByTestId("detail-invocations")).toBeNull();

    fireEvent.click(screen.getByText("select-gstack"));

    expect((await screen.findByTestId("detail-invocations")).textContent).toBe(
      "37"
    );
    expect(screen.getByTestId("detail-device-count").textContent).toBe("5");
    expect(db.getPackAnalytics).toHaveBeenCalledWith("gstack");
  });
});

describe("PluginsPanel coverage — catalog load failure", () => {
  it("shows the error state when getCatalog rejects", async () => {
    installDesktopApi({
      getCatalog: vi.fn().mockRejectedValue(new Error("network down")),
    });
    renderWithNav(<PluginsPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("plugins-error")).toBeDefined()
    );
  });
});

describe("PluginsPanel coverage — contents-unavailable recovery", () => {
  it("clears a pack from the unavailable set once a later fetch succeeds", async () => {
    const getCatalogContents = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([]);
    let resolveDetail: (detail: null) => void = () => undefined;
    const getPackDetail = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveDetail = resolve;
        })
    );
    installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
      getCatalogContents,
      getPackDetail,
    });
    renderWithNav(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("pv-rtk")).toBeDefined());

    fireEvent.click(screen.getByText("select-rtk"));
    await waitFor(() =>
      expect(
        screen.getByTestId("detail-contents-unavailable").textContent
      ).toBe("true")
    );
    expect(getCatalogContents).toHaveBeenCalledTimes(1);

    // Held until now so the failed state is observable. Landing the detail
    // gives `hydratePack` a new identity, the selection effect re-runs, and
    // `contentsById` still lacks "rtk", so contents are fetched again.
    act(() => {
      resolveDetail(null);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("detail-contents-unavailable").textContent
      ).toBe("false")
    );
    expect(getCatalogContents).toHaveBeenCalledTimes(2);
  });
});

describe("PluginsPanel coverage — run status badge, running state", () => {
  it("shows Running for a null exitCode", async () => {
    installDesktopApi({
      getCatalog: vi.fn().mockResolvedValue([makeCatalogEntry()]),
      getInstallRuns: vi.fn().mockResolvedValue([makeRun({ exitCode: null })]),
    });
    renderWithNav(<PluginsPanel />);

    await waitFor(() => expect(screen.getByText("Running")).toBeDefined());
  });
});
