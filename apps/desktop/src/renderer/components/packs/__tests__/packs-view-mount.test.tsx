/**
 * @file packs-view-mount.test.tsx
 * @description Behavioral regression guard for the desktop Packs page (FEA-4159,
 * updated for the FEA-4166 member slot).
 *
 * The sibling `packs-view.test.tsx` stubs the member surface to assert the shell
 * + capability wiring, so it can't catch a crash *inside* the real member view.
 * This file mounts the REAL `PacksView` (unstubbed member `MemberView` + its real
 * `PluginsPanel` Available slot) and proves the page renders honest
 * content/error states without throwing across the desktop provider situations.
 *
 * Root cause it guards (FEA-4159): `PluginsPanel` read the extended-content-kinds
 * flag through the NON-optional `useFeatureFlagEnabled`, which HARD-THROWS when no
 * `FeatureFlagAdapterProvider` is mounted. Because the desktop renderer's root
 * error boundary sits above the whole app, that throw white-screens the entire
 * window (the reported "Packs page renders blank / fails"). The fix reads the
 * flag through `useFeatureFlagEnabledOptional`, so a missing provider degrades to
 * flag-off instead of crashing. FEA-4166 moved `PluginsPanel` under the member
 * `MemberView`'s Available slot, so this guard now drives the by-source view with
 * a populated catalog so the Available region (and its real `PluginsPanel`)
 * actually mounts — the exact path the flag-provider crash lived on.
 */

import {
  type CatalogItemDto,
  CatalogItemScope,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
import { catalogItemToPackView } from "@repo/app/packs/lib/catalog-item-to-pack-view";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
} from "@repo/app/shared/api/api-timeout";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogEntry,
  InstalledPack,
  InstallRunRecord,
} from "../../../../shared/agent-db-contract";
import { PacksView } from "../packs-view";

const useAdminPackViewsMock = vi.fn();
const useAuthSnapshotMock = vi.fn();

// The member view resolves the org catalog + distributions through the shared
// data ports; drive them directly so the by-source view mounts its real body
// (including the PluginsPanel Available slot) without a live cloud API.
vi.mock("@repo/app/packs/hooks/use-admin-pack-views", () => ({
  useAdminPackViews: () => useAdminPackViewsMock(),
}));

vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => ({
  useAuthSnapshot: () => useAuthSnapshotMock(),
}));

const SEED_ENTRY: CatalogEntry = {
  packId: "rtk",
  displayName: "RTK",
  category: "tools",
  githubUrl: "https://github.com/acme/rtk",
  marketplaceUrl: null,
  description: "Rust Token Killer",
  descriptionLive: null,
  harnesses: ["claude"],
  installCommands: { claude: "install rtk" },
  uninstallCommands: null,
  installNotes: null,
  placeholderReason: null,
  verified: true,
  readmeExcerpt: null,
  stars: 10,
  forks: 2,
  lastRelease: null,
  seedVersion: 1,
  pinOrder: 1,
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
};

type CatalogApi = {
  getCatalog: () => Promise<CatalogEntry[]>;
  getInstalledPacks: () => Promise<InstalledPack[]>;
  getInstallRuns: () => Promise<InstallRunRecord[]>;
};

function stubDesktopApi(db: CatalogApi | null): void {
  // Stub only the `desktopApi` property, not the whole `window` object, so the
  // rest of jsdom's window stays intact; `unstubAllGlobals` restores the
  // original descriptor (absent) after each test so nothing leaks between tests.
  vi.stubGlobal("desktopApi", db ? { db } : {});
}

const AVAILABLE_CATALOG_ITEM: CatalogItemDto = {
  id: "cat-1",
  organizationId: "org-1",
  targetKind: "skill",
  source: CatalogItemSource.Curated,
  scope: CatalogItemScope.Global,
  name: "Some Pack",
  description: "An available catalog pack",
  version: "1.0.0",
  sortOrder: 0,
  enabled: true,
  archived: false,
  coaching: false,
  coachingConfig: null,
  parentPackId: null,
  content: null,
  components: [],
  agentSlug: null,
  logoUrl: null,
  createdById: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

// A single available catalog pack so the by-source MemberView renders its
// Available region — which is where the real PluginsPanel now mounts. It has no
// distribution, so it lands in Available (not Required/Installed).
function setAvailablePack(): void {
  useAuthSnapshotMock.mockReturnValue({
    isLoaded: true,
    userId: "member-me",
    orgId: "org-1",
    getToken: () => Promise.resolve(null),
  });
  useAdminPackViewsMock.mockReturnValue({
    packViews: [catalogItemToPackView(AVAILABLE_CATALOG_ITEM)],
    distributionByCatalogId: new Map(),
    distributedRows: [],
    isLoading: false,
    error: null,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PacksView desktop mount (FEA-4159 / FEA-4166)", () => {
  it("mounts the real member view + PluginsPanel WITHOUT a FeatureFlagAdapterProvider (degrades to flag-off, does not throw)", () => {
    // No provider mounted at all: pre-fix this hard-threw
    // "Feature-flag hooks require a <FeatureFlagAdapterProvider> ancestor",
    // which the root error boundary turns into a blank window.
    setAvailablePack();
    stubDesktopApi({
      getCatalog: () => Promise.resolve([]),
      getInstalledPacks: () => Promise.resolve([]),
      getInstallRuns: () => Promise.resolve([]),
    });

    expect(() => render(<PacksView />)).not.toThrow();
    // The shell still renders its honest heading.
    expect(
      screen.getByRole("heading", { name: "Packs", level: 1 })
    ).toBeDefined();
  });

  it("renders the by-source member view with catalog data under the desktop providers", async () => {
    setAvailablePack();
    stubDesktopApi({
      getCatalog: () => Promise.resolve([SEED_ENTRY]),
      getInstalledPacks: () => Promise.resolve([]),
      getInstallRuns: () => Promise.resolve([]),
    });
    const nav = createMemoryNavigation({ initialPath: "/packs" });

    render(
      <NavigationProvider adapter={nav.adapter}>
        <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
          <PacksView />
        </FeatureFlagAdapterProvider>
      </NavigationProvider>
    );

    // The by-source view renders both regions: "Your packs" (the grouped
    // treatment) and "Available" (which mounts the real PluginsPanel — the
    // Available body is the slot, not the passive list). The real PluginsPanel
    // resolves its own local catalog and surfaces RTK — real content, not a
    // blank page, and proof the flag hook didn't crash the mount.
    expect(screen.getByRole("region", { name: "Your packs" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Available" })).toBeDefined();
    expect(await screen.findByText("RTK")).toBeDefined();
  });

  /**
   * ISS-5655: the sibling test below injects a PLAIN `Error`, so
   * `PacksLoadFailed`'s `error instanceof ApiError && error.isTimeout()` is
   * false and only the GENERIC branch ever runs. That made this file read as
   * coverage for ISS-5002 — `/packs` never finishing loading because `apiFetch`
   * had no deadline — while the timeout branch it is named for stayed
   * unreachable. `packs-load-failed.test.tsx` covers that branch on the
   * component in isolation; what was missing is proof that the DESKTOP mount
   * actually threads the error OBJECT through `MemberView` rather than
   * collapsing it to a boolean `isError`, which is the only way the distinct
   * copy can reach a user here.
   */
  it("states a client-deadline timeout distinctly, through the real desktop mount", async () => {
    useAuthSnapshotMock.mockReturnValue({
      isLoaded: true,
      userId: "member-me",
      orgId: "org-1",
      getToken: () => Promise.resolve(null),
    });
    useAdminPackViewsMock.mockReturnValue({
      packViews: [],
      distributionByCatalogId: new Map(),
      distributedRows: [],
      isLoading: false,
      error: new ApiError(API_TIMEOUT_ERROR_MESSAGE, API_NO_RESPONSE_STATUS, {
        code: API_TIMEOUT_ERROR_CODE,
      }),
    });
    stubDesktopApi(null);

    render(
      <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
        <PacksView />
      </FeatureFlagAdapterProvider>
    );

    await waitFor(() =>
      expect(screen.getByText("Packs took too long to load")).toBeDefined()
    );
    // The generic server-failure copy would be a lie about what happened: no
    // answer was ever received, so nothing was "answered with a failure".
    expect(screen.queryByText("Couldn't load packs")).toBeNull();
  });

  it("renders an honest error state (not a blank page) when the catalog read fails", async () => {
    useAuthSnapshotMock.mockReturnValue({
      isLoaded: true,
      userId: "member-me",
      orgId: "org-1",
      getToken: () => Promise.resolve(null),
    });
    useAdminPackViewsMock.mockReturnValue({
      packViews: [],
      distributionByCatalogId: new Map(),
      distributedRows: [],
      isLoading: false,
      error: new Error("catalog read failed"),
    });
    stubDesktopApi(null);

    render(
      <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
        <PacksView />
      </FeatureFlagAdapterProvider>
    );

    await waitFor(() =>
      expect(screen.getByText("Couldn't load packs")).toBeDefined()
    );
  });
});
