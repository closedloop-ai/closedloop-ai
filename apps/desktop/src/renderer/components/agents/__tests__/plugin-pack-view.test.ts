/**
 * @description Unit tests for the desktop catalog → PackView adapter. Pure
 * mapping logic (no React / design-system), so it runs fast and isolates the
 * field-mapping contract the Plugins UX depends on.
 */
import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
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
  packAnalyticsToBlocks,
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
      {
        name: "plan-agent",
        type: "agent",
        description: "plans",
        content: "# Plan agent",
      },
      { name: "/code", type: "command" },
      { name: "weird", type: "totally-unknown" },
      {
        name: "malformed",
        type: "skill",
        content: { body: "not a string" },
      } as unknown as CatalogContentItem,
      {
        name: "missing-description",
        type: "plugin",
        description: null,
      },
      {
        name: "bad-description",
        type: "plugin",
        description: { text: "not a string" },
      } as unknown as CatalogContentItem,
    ];
    const view = catalogEntryToPackView(
      makeEntry({ contentsCache: contents }),
      []
    );
    expect(view.contents).toEqual([
      {
        name: "plan-agent",
        kind: PackContentKind.Agent,
        description: "plans",
        content: "# Plan agent",
      },
      {
        name: "/code",
        kind: PackContentKind.Command,
        description: null,
        content: null,
      },
      // Unknown kinds fall back to the generic `plugin` bucket.
      {
        name: "weird",
        kind: PackContentKind.Plugin,
        description: null,
        content: null,
      },
      {
        name: "malformed",
        kind: PackContentKind.Skill,
        description: null,
        content: null,
      },
      {
        name: "missing-description",
        kind: PackContentKind.Plugin,
        description: null,
        content: null,
      },
      {
        name: "bad-description",
        kind: PackContentKind.Plugin,
        description: null,
        content: null,
      },
    ]);
  });

  it("lets a fresh contents override replace the cached contents", () => {
    const view = catalogEntryToPackView(
      makeEntry({ contentsCache: [{ name: "stale", type: "skill" }] }),
      [],
      [{ name: "fresh", type: "skill" }]
    );
    expect(view.contents).toEqual([
      {
        name: "fresh",
        kind: PackContentKind.Skill,
        description: null,
        content: null,
      },
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

/**
 * ISS-6462: the desktop half of the merged-PR coverage carry. `mergedPrs` is a
 * count over a bounded sample of the cohort sessions, and this mapper used
 * to drop the flag that says so, so the overlay's Performance tile printed a
 * capped scan as an exact count.
 */
describe("packAnalyticsToBlocks merged-PR coverage", () => {
  function makeAnalytics(
    over: Partial<PackAnalyticsResponse> = {}
  ): PackAnalyticsResponse {
    return {
      packId: "code",
      invocations: 1284,
      sessions: 412,
      locPerDollar: 3.2,
      owners: ["Maya Chen"],
      deviceCount: 12,
      locDelta: 18,
      successRate: 74,
      successDelta: 9,
      tokenEfficiencyDelta: 12,
      efficiencyTrend: [4, 5, 6],
      mergedPrs: 996,
      mergedPrsTruncated: false,
      qualityScore: null,
      qualityDelta: null,
      ...over,
    };
  }

  it("carries a declared coverage flag through in both directions", () => {
    expect(
      packAnalyticsToBlocks(makeAnalytics({ mergedPrsTruncated: true }))
        .performance.mergedPrsTruncated
    ).toBe(true);
    expect(
      packAnalyticsToBlocks(makeAnalytics({ mergedPrsTruncated: false }))
        .performance.mergedPrsTruncated
    ).toBe(false);
  });

  it("carries a declared baseline sample size in both directions (ISS-9853)", () => {
    expect(
      packAnalyticsToBlocks(makeAnalytics({ baselineSampleSize: 500 }))
        .performance.baselineSampleSize
    ).toBe(500);
    // `null` is a DECLARED state here — "the comparator was not a strict
    // sample" — unlike the truncation flag's null, so it must ride through.
    expect(
      packAnalyticsToBlocks(makeAnalytics({ baselineSampleSize: null }))
        .performance.baselineSampleSize
    ).toBeNull();
  });

  it("preserves an omitted baseline sample size as undeclared (ISS-9853)", () => {
    const analytics = makeAnalytics({ baselineSampleSize: 500 });
    Reflect.deleteProperty(analytics, "baselineSampleSize");

    const { performance } = packAnalyticsToBlocks(analytics);

    // A producer predating the field sampled the same way and could not say so;
    // folding that to `null` would assert a whole-window comparison.
    expect(performance.baselineSampleSize).toBeUndefined();
    expect(performance.baselineSampleSize).not.toBeNull();
  });

  it("preserves an omitted flag as unknown rather than folding it to false", () => {
    // A cloud predating the disclosure applies the same cap and cannot report
    // it, so reading omission as "not truncated" would re-assert full-cohort
    // coverage exactly when it does not hold.
    const analytics = makeAnalytics();
    Reflect.deleteProperty(analytics, "mergedPrsTruncated");

    const { performance } = packAnalyticsToBlocks(analytics);

    expect(performance.mergedPrsTruncated).toBeUndefined();
    expect(performance.mergedPrsTruncated).not.toBe(false);
  });

  /**
   * ISS-6768: the desktop shell's half of the roster. `PackDetail` is shared with
   * the web Packs catalog, and both adapters now map ONE cloud-produced roster
   * through `packInstallersFromNames` — so the render-key property the web suite
   * pins has to hold on this adapter too, on the payload this shell actually
   * receives. `owners` is the desktop wire field; a same-named pair arriving on it
   * must still reach `PackDetail` as two rows under two keys.
   */
  it("maps the cloud roster to distinct render ids, same-named installers included", () => {
    const { teamUsage } = packAnalyticsToBlocks(
      makeAnalytics({ owners: ["Alex", "Alex", "Alex#2"] })
    );

    expect(teamUsage.installers?.map((user) => user.name)).toEqual([
      "Alex",
      "Alex",
      "Alex#2",
    ]);
    // The ids are `PackDetail`'s React keys at both render sites; a duplicate
    // makes React reconcile two different people onto one row.
    const ids = teamUsage.installers?.map((user) => user.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    // Headcount is the roster length, not a name-deduped set.
    expect(teamUsage.installedCount).toBe(3);
  });

  it("prefers the exact installerCount over owners.length (ISS-9854)", () => {
    const { teamUsage } = packAnalyticsToBlocks(
      makeAnalytics({ owners: ["Alice", "Bob"], installerCount: 7000 })
    );

    expect(teamUsage.installedCount).toBe(7000);
    expect(teamUsage.installers).toHaveLength(2);
  });

  it("falls back to owners.length when installerCount is absent (ISS-9854 version skew)", () => {
    const analytics = makeAnalytics({ owners: ["Alice", "Bob"] });
    Reflect.deleteProperty(analytics, "installerCount");

    const { teamUsage } = packAnalyticsToBlocks(analytics);

    expect(teamUsage.installedCount).toBe(2);
  });
});
