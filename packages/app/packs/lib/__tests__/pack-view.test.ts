import { describe, expect, it } from "vitest";
import {
  adoptionShare,
  categoryDisplayLabel,
  installCount,
  installCountOrUnavailable,
  PackContentKind,
  type PackView,
  packDisambiguators,
  toPackContentKind,
  trendingPackIds,
  trendSlope,
} from "../pack-view";

function makePackView(overrides: Partial<PackView> & { id: string }): PackView {
  return {
    name: "pack",
    verified: false,
    harnesses: [],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
    ...overrides,
  };
}

describe("categoryDisplayLabel", () => {
  it("renders a known content kind through the canonical label map", () => {
    // The card must read "MCP tool" (the detail Contents label), never "Mcp".
    expect(categoryDisplayLabel(PackContentKind.Mcp)).toBe("MCP tool");
    expect(categoryDisplayLabel("agent")).toBe("Agent");
  });

  it("title-cases a free-text category, collapsing separator variants", () => {
    expect(categoryDisplayLabel("plan-review")).toBe("Plan Review");
    expect(categoryDisplayLabel("plan_review")).toBe("Plan Review");
    expect(categoryDisplayLabel("Security")).toBe("Security");
  });
});

describe("packDisambiguators", () => {
  it("returns no qualifier for uniquely-named packs", () => {
    const packs = [
      makePackView({ id: "a", name: "test-strategist" }),
      makePackView({ id: "b", name: "security-privacy" }),
    ];

    const qualifiers = packDisambiguators(packs);

    expect(qualifiers.size).toBe(0);
    expect(qualifiers.get("a")).toBeUndefined();
    expect(qualifiers.get("b")).toBeUndefined();
  });

  it("disambiguates same-named packs by category, rendered through the kind map", () => {
    const packs = [
      makePackView({
        id: "a",
        name: "test-strategist",
        category: PackContentKind.Agent,
      }),
      makePackView({
        id: "b",
        name: "test-strategist",
        category: PackContentKind.Mcp,
      }),
    ];

    const qualifiers = packDisambiguators(packs);

    expect(qualifiers.get("a")).toBe("Agent");
    // "mcp" reads as "MCP tool", not "Mcp".
    expect(qualifiers.get("b")).toBe("MCP tool");
  });

  it("falls back to version when category matches", () => {
    const packs = [
      makePackView({
        id: "a",
        name: "security-privacy",
        category: PackContentKind.Agent,
        version: "1.0.0",
      }),
      makePackView({
        id: "b",
        name: "security-privacy",
        category: PackContentKind.Agent,
        version: "2.3.1",
      }),
    ];

    const qualifiers = packDisambiguators(packs);

    expect(qualifiers.get("a")).toBe("v1.0.0");
    expect(qualifiers.get("b")).toBe("v2.3.1");
  });

  it("picks one axis for the whole collision group, not per pack", () => {
    // The classic three-way case: two packs share the category, one is unique.
    // Category does NOT separate everyone, so the whole group falls through to
    // version — no card is left comparing "Agent" against "v2.0.0"/"v3.0.0".
    const packs = [
      makePackView({
        id: "a",
        name: "test-strategist",
        category: PackContentKind.Skill,
        version: "1.0.0",
      }),
      makePackView({
        id: "b",
        name: "test-strategist",
        category: PackContentKind.Agent,
        version: "2.0.0",
      }),
      makePackView({
        id: "c",
        name: "test-strategist",
        category: PackContentKind.Agent,
        version: "3.0.0",
      }),
    ];

    const qualifiers = packDisambiguators(packs);

    // Every card in the group reads on the same (version) axis.
    expect(qualifiers.get("a")).toBe("v1.0.0");
    expect(qualifiers.get("b")).toBe("v2.0.0");
    expect(qualifiers.get("c")).toBe("v3.0.0");
  });

  it("compares rendered category values, so separator variants do not separate", () => {
    // "plan-review" and "plan_review" both render "Plan Review": category does
    // NOT separate the group, so it falls through to version.
    const packs = [
      makePackView({
        id: "a",
        name: "audit",
        category: "plan-review",
        version: "1.0.0",
      }),
      makePackView({
        id: "b",
        name: "audit",
        category: "plan_review",
        version: "2.0.0",
      }),
    ];

    const qualifiers = packDisambiguators(packs);

    expect(qualifiers.get("a")).toBe("v1.0.0");
    expect(qualifiers.get("b")).toBe("v2.0.0");
  });

  it("compares rendered version values, so 1.0.0 and v1.0.0 do not separate", () => {
    // Both render "v1.0.0": version does not separate, so the group falls to the
    // publisher last resort.
    const packs = [
      makePackView({
        id: "a",
        name: "audit",
        category: PackContentKind.Agent,
        version: "1.0.0",
        publisher: "acme",
      }),
      makePackView({
        id: "b",
        name: "audit",
        category: PackContentKind.Agent,
        version: "v1.0.0",
        publisher: "globex",
      }),
    ];

    const qualifiers = packDisambiguators(packs);

    expect(qualifiers.get("a")).toBe("acme");
    expect(qualifiers.get("b")).toBe("globex");
  });

  it("falls back to a person-actionable publisher before any id fragment", () => {
    const packs = [
      makePackView({
        id: "0192f0000000700080000000000000a1",
        name: "audit",
        category: PackContentKind.Agent,
        version: "1.0.0",
        publisher: "acme",
      }),
      makePackView({
        id: "0192f0000000700080000000000000a2",
        name: "audit",
        category: PackContentKind.Agent,
        version: "1.0.0",
        publisher: "globex",
      }),
    ];

    const qualifiers = packDisambiguators(packs);

    // A real word someone can act on, not "#0192f000".
    expect(qualifiers.get("0192f0000000700080000000000000a1")).toBe("acme");
    expect(qualifiers.get("0192f0000000700080000000000000a2")).toBe("globex");
  });

  it("extends the id fragment until unique for same-window UUIDv7 ids", () => {
    // These UUIDv7 ids share the first 8 hex chars (same ~65s mint window) and
    // have no publisher, category, or version to separate them. An 8-char slice
    // would collide, so the fragment must extend until it is unique.
    const idA = "0192f0000000700080000000000000a1";
    const idB = "0192f0000000700080000000000000b2";
    const packs = [
      makePackView({ id: idA, name: "audit" }),
      makePackView({ id: idB, name: "audit" }),
    ];

    const qualifiers = packDisambiguators(packs);

    const qa = qualifiers.get(idA);
    const qb = qualifiers.get(idB);
    expect(qa).not.toEqual(qb);
    // Same first 8 chars, so the fragment grew past 8.
    expect(qa?.length).toBeGreaterThan(1 + 8);
    expect(idA.startsWith(qa?.slice(1) ?? "")).toBe(true);
  });

  it("shows slug ids whole rather than chopping a word", () => {
    // Desktop pack ids are slugs; a chopped "#self-lea" reads as a bug.
    const packs = [
      makePackView({ id: "self-learning", name: "audit" }),
      makePackView({ id: "code", name: "audit" }),
    ];

    const qualifiers = packDisambiguators(packs);

    expect(qualifiers.get("self-learning")).toBe("#self-learning");
    expect(qualifiers.get("code")).toBe("#code");
  });

  it("groups names that differ only by internal whitespace (HTML collapses it)", () => {
    // "Security  Privacy" and "Security Privacy" render identically, so they must
    // collide and each get a qualifier.
    const packs = [
      makePackView({
        id: "a",
        name: "Security  Privacy",
        category: PackContentKind.Agent,
      }),
      makePackView({
        id: "b",
        name: "Security Privacy",
        category: PackContentKind.Skill,
      }),
    ];

    const qualifiers = packDisambiguators(packs);

    expect(qualifiers.get("a")).toBe("Agent");
    expect(qualifiers.get("b")).toBe("Skill");
  });

  it("matches names case-insensitively and after trimming", () => {
    const packs = [
      makePackView({
        id: "a",
        name: "Test-Strategist",
        category: PackContentKind.Agent,
      }),
      makePackView({
        id: "b",
        name: "  test-strategist ",
        category: PackContentKind.Skill,
      }),
    ];

    const qualifiers = packDisambiguators(packs);

    expect(qualifiers.get("a")).toBe("Agent");
    expect(qualifiers.get("b")).toBe("Skill");
  });
});

describe("pack view metric derivations", () => {
  it("normalizes known content kinds and defaults unknown values to plugin", () => {
    expect(toPackContentKind("SKILL")).toBe(PackContentKind.Skill);
    expect(toPackContentKind(undefined)).toBe(PackContentKind.Plugin);
    expect(toPackContentKind("future-kind")).toBe(PackContentKind.Plugin);
  });

  it("distinguishes measured zero installs from an unavailable roster", () => {
    const unavailable = makePackView({ id: "unknown" });
    const roster = makePackView({
      id: "roster",
      teamUsage: {
        installers: [
          { id: "user-1", name: "Ada", initials: "AL" },
          { id: "user-2", name: "Grace", initials: "GH" },
        ],
        installTrend: [],
      },
    });
    const measured = makePackView({
      id: "measured",
      teamUsage: { installedCount: 0, installTrend: [] },
    });

    expect(installCountOrUnavailable(unavailable)).toBeNull();
    expect(installCount(unavailable)).toBe(0);
    expect(installCountOrUnavailable(roster)).toBe(2);
    expect(installCountOrUnavailable(measured)).toBe(0);
  });

  it("computes adoption only with a positive team size and measured installs", () => {
    expect(adoptionShare(makePackView({ id: "missing" }))).toBeNull();
    expect(
      adoptionShare(
        makePackView({
          id: "zero-size",
          teamUsage: { installedCount: 1, teamSize: 0, installTrend: [] },
        })
      )
    ).toBeNull();
    expect(
      adoptionShare(
        makePackView({
          id: "measured",
          teamUsage: { installedCount: 2, teamSize: 3, installTrend: [] },
        })
      )
    ).toBe(67);
  });

  it("derives slopes and marks only catalog-relative climbers", () => {
    const flat = packWithTrend("flat", [1]);
    const slow = packWithTrend("slow", [1, 2]);
    const medium = packWithTrend("medium", [1, 4]);
    const fast = packWithTrend("fast", [1, 6]);
    expect(trendSlope(flat)).toBe(0);
    expect(trendSlope(fast)).toBe(5);
    expect(trendingPackIds([flat, fast])).toEqual(new Set());
    expect(trendingPackIds([flat, slow, medium, fast])).toEqual(
      new Set(["medium", "fast"])
    );
  });

  it("handles an even number of climbing slopes at the median boundary", () => {
    expect(
      trendingPackIds([
        packWithTrend("one", [0, 1]),
        packWithTrend("two", [0, 2]),
        packWithTrend("three", [0, 3]),
        packWithTrend("four", [0, 4]),
      ])
    ).toEqual(new Set(["three", "four"]));
  });
});

function packWithTrend(id: string, installTrend: number[]): PackView {
  return makePackView({
    id,
    teamUsage: { installTrend },
  });
}
