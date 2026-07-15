/**
 * @file plugin-pack-view.test.ts
 * @description Unit tests for the desktop catalog → PackView adapter. Pure
 * mapping logic (no React / design-system), so it runs fast and isolates the
 * field-mapping contract the Plugins UX depends on.
 */
import { PackContentKind } from "@repo/app/packs/lib/pack-view";
import { describe, expect, it } from "vitest";
import type {
  CatalogContentItem,
  CatalogEntry,
  InstalledPack,
} from "../../../../shared/agent-db-contract";
import {
  buildPackViews,
  buildPackViewsFromInstalledMap,
  catalogEntryToPackView,
} from "../plugin-pack-view";

function makeEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    packId: "code",
    displayName: "code",
    category: "framework",
    githubUrl: "https://github.com/closedloop-ai/claude-plugins",
    marketplaceUrl: null,
    description: "core coding plugin",
    descriptionLive: null,
    harnesses: ["claude", "codex"],
    installCommands: null,
    uninstallCommands: null,
    installNotes: null,
    placeholderReason: null,
    verified: true,
    readmeExcerpt: null,
    stars: 2140,
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
    usageCount: 42,
    history: [
      { fetchedAt: "2026-07-01", stars: 2000, forks: 10 },
      { fetchedAt: "2026-07-08", stars: 2140, forks: 12 },
    ],
    ...over,
  };
}

describe("catalogEntryToPackView", () => {
  it("maps core fields and derives publisher from the GitHub owner", () => {
    const view = catalogEntryToPackView(makeEntry(), ["claude"]);
    expect(view.id).toBe("code");
    expect(view.name).toBe("code");
    expect(view.publisher).toBe("closedloop-ai");
    expect(view.stars).toBe(2140);
    expect(view.starHistory).toEqual([2000, 2140]);
    expect(view.verified).toBe(true);
    expect(view.harnesses).toEqual(["claude", "codex"]);
    expect(view.usageCount).toBe(42);
  });

  it("marks installedByMe true when installed harnesses are present", () => {
    expect(catalogEntryToPackView(makeEntry(), []).installedByMe).toBe(false);
    expect(catalogEntryToPackView(makeEntry(), ["claude"]).installedByMe).toBe(
      true
    );
  });

  it("prefers the live description when present", () => {
    const view = catalogEntryToPackView(
      makeEntry({ descriptionLive: "fresh copy" }),
      []
    );
    expect(view.description).toBe("fresh copy");
  });

  it("maps cached contents to PackContentEntries with coerced kinds", () => {
    const contents: CatalogContentItem[] = [
      { name: "plan-agent", type: "agent", description: "plans" },
      { name: "/code", type: "command" },
      { name: "weird", type: "totally-unknown" },
    ];
    const view = catalogEntryToPackView(
      makeEntry({ contentsCache: contents }),
      []
    );
    expect(view.contents).toEqual([
      { name: "plan-agent", kind: PackContentKind.Agent, description: "plans" },
      { name: "/code", kind: PackContentKind.Command, description: null },
      // Unknown kinds fall back to the generic `plugin` bucket.
      { name: "weird", kind: PackContentKind.Plugin, description: null },
    ]);
  });

  it("lets a fresh contents override replace the cached contents", () => {
    const view = catalogEntryToPackView(
      makeEntry({ contentsCache: [{ name: "stale", type: "skill" }] }),
      [],
      [{ name: "fresh", type: "skill" }]
    );
    expect(view.contents).toEqual([
      { name: "fresh", kind: PackContentKind.Skill, description: null },
    ]);
  });

  it("has no multiplayer/analytics blocks (single-player desktop)", () => {
    const view = catalogEntryToPackView(makeEntry(), []);
    expect(view.teamUsage).toBeNull();
    expect(view.performance).toBeNull();
    expect(view.distribution).toBeNull();
  });
});

describe("buildPackViews", () => {
  it("merges installed harnesses from getInstalledPacks by pack id", () => {
    const catalog: CatalogEntry[] = [
      makeEntry({ packId: "code" }),
      makeEntry({ packId: "posthog", harnesses: ["claude"] }),
    ];
    const installed: InstalledPack[] = [
      {
        packId: "code",
        harnesses: ["claude"],
        installs: [],
        skillCount: 0,
        lastSeenAt: null,
      },
    ];
    const views = buildPackViews(catalog, installed);
    const code = views.find((v) => v.id === "code");
    const posthog = views.find((v) => v.id === "posthog");
    expect(code?.installedHarnesses).toEqual(["claude"]);
    expect(code?.installedByMe).toBe(true);
    expect(posthog?.installedByMe).toBe(false);
  });
});

describe("buildPackViewsFromInstalledMap", () => {
  it("merges installed harnesses from a pre-built packId → harnesses map", () => {
    const catalog: CatalogEntry[] = [
      makeEntry({ packId: "code" }),
      makeEntry({ packId: "posthog", harnesses: ["claude"] }),
    ];
    const installedByPackId = new Map<string, string[]>([["code", ["claude"]]]);
    const views = buildPackViewsFromInstalledMap(catalog, installedByPackId);
    const code = views.find((v) => v.id === "code");
    const posthog = views.find((v) => v.id === "posthog");
    expect(code?.installedHarnesses).toEqual(["claude"]);
    expect(code?.installedByMe).toBe(true);
    expect(posthog?.installedByMe).toBe(false);
  });

  it("falls back to the entry's own installedHarnesses when the map has no row", () => {
    const catalog: CatalogEntry[] = [
      makeEntry({ packId: "code", installedHarnesses: ["codex"] }),
    ];
    const views = buildPackViewsFromInstalledMap(catalog, new Map());
    expect(views[0]?.installedHarnesses).toEqual(["codex"]);
    expect(views[0]?.installedByMe).toBe(true);
  });

  it("produces output identical to buildPackViews for the same inputs (the plugins-panel path is behavior-preserving)", () => {
    const catalog: CatalogEntry[] = [
      makeEntry({ packId: "code" }),
      makeEntry({ packId: "posthog", harnesses: ["claude"] }),
    ];
    const installed: InstalledPack[] = [
      {
        packId: "code",
        harnesses: ["claude"],
        installs: [],
        skillCount: 0,
        lastSeenAt: null,
      },
    ];
    // plugins-panel keeps installed state as this map; buildPackViews builds it
    // internally from the raw rows. Both must yield the same PackView[].
    const installedByPackId = new Map<string, string[]>(
      installed.map((p) => [p.packId, p.harnesses])
    );
    expect(buildPackViewsFromInstalledMap(catalog, installedByPackId)).toEqual(
      buildPackViews(catalog, installed)
    );
  });
});
