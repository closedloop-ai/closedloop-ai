/**
 * @file plugins-panel.content-install-state.test.tsx
 * @description FEA-4071 — the desktop PluginsPanel derives per-component install
 * state for the detail Contents tab from the machine's real installed-component
 * truth (`getPackDetail`).
 *
 * Proves the ACT/READ wiring: on pack-select the panel calls `getPackDetail`,
 * and the `detailPack.contents` it hands the shared workspace carry the honest
 * per-component `installState` (Installed for a component the machine reports,
 * NotInstalled for one it doesn't). A stub `PacksWorkspace` surfaces the select
 * callback and renders the detail contents' resolved states so the assertion is
 * on the container's real output, not a mock's internals.
 */

import { PackInstallState } from "@repo/app/packs/lib/install-state";
import type { PackView } from "@repo/app/packs/lib/pack-view";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogContentItem,
  CatalogEntry,
  InstalledPackDetail,
} from "../../../../shared/agent-db-contract";
import { PluginsPanel } from "../plugins-panel";

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: () => false,
}));

// Stub the workspace so the test can (a) trigger a pack-select and (b) read the
// resolved detail contents + their per-component install state off the real
// container output.
vi.mock("@repo/app/packs/components/packs-workspace", () => ({
  PacksWorkspace: (props: {
    packs: PackView[];
    detailPack?: PackView | null;
    onSelectPack?: (id: string | null) => void;
    onInstall?: (packId: string, harness?: string) => void;
    onUninstall?: (packId: string, harness: string) => void;
  }) => (
    <div data-testid="packs-workspace">
      {props.packs.map((pack) => (
        <button
          data-testid={`select-${pack.id}`}
          key={pack.id}
          onClick={() => props.onSelectPack?.(pack.id)}
          type="button"
        >
          {pack.name}
        </button>
      ))}
      {props.detailPack ? (
        <div>
          <button
            data-testid="install"
            onClick={() => props.onInstall?.(props.detailPack?.id ?? "")}
            type="button"
          >
            install
          </button>
          <button
            data-testid="uninstall"
            onClick={() =>
              props.onUninstall?.(props.detailPack?.id ?? "", "claude")
            }
            type="button"
          >
            uninstall
          </button>
          <ul data-testid="detail-contents">
            {props.detailPack.contents.map((item) => (
              <li data-testid={`content-${item.name}`} key={item.name}>
                {item.name}: {item.installState ?? "unknown"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  ),
}));

vi.mock("@repo/app/packs/components/packs-workspace-skeleton", () => ({
  PacksWorkspaceSkeleton: () => <div data-testid="skeleton" />,
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

const CONTENTS: CatalogContentItem[] = [
  { name: "Code Review", type: "skill", description: "review" },
  { name: "Plan Builder", type: "command", description: "plan" },
];

// The stub renders "unknown" for a content entry with no resolved installState.
const UNKNOWN_STATE_RE = /unknown/;

function makePackDetail(
  over: Partial<InstalledPackDetail> = {}
): InstalledPackDetail {
  return {
    packId: "rtk",
    harnesses: ["claude"],
    installs: [],
    skillCount: 1,
    lastSeenAt: null,
    skills: [
      {
        skillId: "s1",
        name: "Code Review",
        version: null,
        description: null,
        harness: "claude",
      },
    ],
    associations: [],
    ...over,
  };
}

type DbMock = {
  getCatalog: ReturnType<typeof vi.fn>;
  getInstalledPacks: ReturnType<typeof vi.fn>;
  getInstallRuns: ReturnType<typeof vi.fn>;
  getCatalogContents: ReturnType<typeof vi.fn>;
  getPackAnalytics: ReturnType<typeof vi.fn>;
  getPackDetail: ReturnType<typeof vi.fn>;
  catalogInstall: ReturnType<typeof vi.fn>;
  catalogUninstall: ReturnType<typeof vi.fn>;
};

function installDesktopApi(db: Partial<DbMock>): DbMock {
  const full: DbMock = {
    getCatalog:
      db.getCatalog ?? vi.fn().mockResolvedValue([makeCatalogEntry()]),
    getInstalledPacks: db.getInstalledPacks ?? vi.fn().mockResolvedValue([]),
    getInstallRuns: db.getInstallRuns ?? vi.fn().mockResolvedValue([]),
    getCatalogContents:
      db.getCatalogContents ?? vi.fn().mockResolvedValue(CONTENTS),
    getPackAnalytics: db.getPackAnalytics ?? vi.fn().mockResolvedValue(null),
    getPackDetail: db.getPackDetail ?? vi.fn().mockResolvedValue(null),
    catalogInstall: db.catalogInstall ?? vi.fn().mockResolvedValue(undefined),
    catalogUninstall:
      db.catalogUninstall ?? vi.fn().mockResolvedValue(undefined),
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

describe("PluginsPanel per-component install state (FEA-4071)", () => {
  it("derives Installed / NotInstalled per component from getPackDetail on select", async () => {
    const db = installDesktopApi({
      getPackDetail: vi.fn().mockResolvedValue(makePackDetail()),
    });

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("select-rtk")).toBeDefined());

    screen.getByTestId("select-rtk").click();

    // The panel fetches the machine's installed-component truth for the pack.
    await waitFor(() => expect(db.getPackDetail).toHaveBeenCalledWith("rtk"));

    // Code Review is in the machine's installed skills → Installed. Plan Builder
    // is a COMMAND: `getPackDetail` enumerates only installed skills, so it can't
    // speak to command-kind entries — the panel leaves it UNKNOWN (no fabricated
    // "not installed") rather than deriving it from the skill inventory.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("content-Code Review")).getByText(
          new RegExp(PackInstallState.Installed)
        )
      ).toBeDefined()
    );
    expect(
      within(screen.getByTestId("content-Plan Builder")).getByText(
        UNKNOWN_STATE_RE
      )
    ).toBeDefined();
  });

  it("does not falsely mark a same-named command Installed off the skill inventory", async () => {
    // A command that shares an installed skill's name must not read Installed —
    // its kind is outside the skill inventory's reach, so it stays UNKNOWN. The
    // installed skill "Code Review" and a same-named command are both bundled.
    installDesktopApi({
      getCatalogContents: vi.fn().mockResolvedValue([
        { name: "Code Review", type: "skill", description: "review" },
        { name: "Plan Builder", type: "command", description: "plan" },
      ] satisfies CatalogContentItem[]),
      getPackDetail: vi.fn().mockResolvedValue(
        // The machine reports BOTH names as installed skills, but Plan Builder
        // is a COMMAND in the catalog — the name-match must not cross kinds.
        makePackDetail({
          skills: [
            {
              skillId: "s1",
              name: "Code Review",
              version: null,
              description: null,
              harness: "claude",
            },
            {
              skillId: "s2",
              name: "Plan Builder",
              version: null,
              description: null,
              harness: "claude",
            },
          ],
        })
      ),
    });

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("select-rtk")).toBeDefined());
    screen.getByTestId("select-rtk").click();

    // The skill resolves Installed; the identically-named command stays unknown
    // even though its name IS in the installed skill set.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("content-Code Review")).getByText(
          new RegExp(PackInstallState.Installed)
        )
      ).toBeDefined()
    );
    expect(
      within(screen.getByTestId("content-Plan Builder")).getByText(
        UNKNOWN_STATE_RE
      )
    ).toBeDefined();
  });

  it("marks bundled SKILLS NotInstalled when the pack has no install detail", async () => {
    // getPackDetail resolves null — the pack is not installed on this machine. A
    // skill-kind component reads an explicit NotInstalled; a command-kind one
    // stays UNKNOWN (the skill read never enumerated commands either way).
    installDesktopApi({ getPackDetail: vi.fn().mockResolvedValue(null) });

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("select-rtk")).toBeDefined());
    screen.getByTestId("select-rtk").click();

    await waitFor(() =>
      expect(
        within(screen.getByTestId("content-Code Review")).getByText(
          new RegExp(PackInstallState.NotInstalled)
        )
      ).toBeDefined()
    );
    expect(
      within(screen.getByTestId("content-Plan Builder")).getByText(
        UNKNOWN_STATE_RE
      )
    ).toBeDefined();
  });

  it("refetches the pack detail after a mutation so the Contents tab updates in place (Codex P1)", async () => {
    // Pre-mutation: the pack is not installed, so Code Review reads NotInstalled.
    // After install, getPackDetail reports it installed — the open Contents tab
    // must flip to Installed without a remount, not keep the stale snapshot.
    const getPackDetail = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(makePackDetail());
    const db = installDesktopApi({ getPackDetail });

    render(<PluginsPanel />);
    await waitFor(() => expect(screen.getByTestId("select-rtk")).toBeDefined());
    screen.getByTestId("select-rtk").click();

    await waitFor(() =>
      expect(
        within(screen.getByTestId("content-Code Review")).getByText(
          new RegExp(PackInstallState.NotInstalled)
        )
      ).toBeDefined()
    );

    // Install the pack from the open detail — the panel refetches its detail.
    await waitFor(() => expect(screen.getByTestId("install")).toBeDefined());
    screen.getByTestId("install").click();

    await waitFor(() =>
      expect(db.catalogInstall).toHaveBeenCalledWith("rtk", "claude")
    );
    // The Contents tab reflects the post-mutation installed set in place.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("content-Code Review")).getByText(
          new RegExp(PackInstallState.Installed)
        )
      ).toBeDefined()
    );
    // getPackDetail was called again after the mutation (select + refetch).
    expect(getPackDetail.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
