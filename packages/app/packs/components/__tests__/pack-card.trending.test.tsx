/**
 * @file pack-card.trending.test.tsx
 * @description The "Trending" marker on the packs grid (FEA-3236). "Trending" is
 * catalog-relative, not per-card: the workspace computes the set of top movers
 * with `trendingPackIds` and passes each card a `trending` flag, so the badge
 * stays selective instead of lighting up on every climbing card. These tests
 * cover both the relative selection helper and the card's render of the flag.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type PackView, trendingPackIds } from "../../lib/pack-view";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PackCard } from "../pack-card";

function packWithTrend(id: string, installTrend: number[]): PackView {
  return {
    id,
    name: `Pack ${id}`,
    verified: false,
    harnesses: ["claude"],
    installedHarnesses: [],
    installedByMe: false,
    stars: 10,
    contents: [],
    teamUsage: {
      installers: [],
      installedCount: 0,
      teamSize: 8,
      installTrend,
    },
  };
}

function packWithoutTrend(id: string): PackView {
  return {
    id,
    name: `Pack ${id}`,
    verified: false,
    harnesses: ["claude"],
    installedHarnesses: [],
    installedByMe: false,
    stars: 10,
    contents: [],
  };
}

describe("trendingPackIds", () => {
  it("selects only the top movers, not every climbing pack", () => {
    // Slopes: steep=6, mid=3, gentle=1, flat=0. Median of the climbers
    // [1, 3, 6] is 3, so only steep + mid qualify — gentle and flat do not.
    const trending = trendingPackIds([
      packWithTrend("steep", [0, 2, 4, 6]),
      packWithTrend("mid", [0, 1, 2, 3]),
      packWithTrend("gentle", [0, 0, 1, 1]),
      packWithTrend("flat", [2, 2, 2, 2]),
    ]);

    expect(trending.has("steep")).toBe(true);
    expect(trending.has("mid")).toBe(true);
    expect(trending.has("gentle")).toBe(false);
    expect(trending.has("flat")).toBe(false);
  });

  it("is empty when adoption is broadly flat", () => {
    const trending = trendingPackIds([
      packWithTrend("a", [3, 3, 3, 3]),
      packWithTrend("b", [1, 1, 1, 1]),
    ]);

    expect(trending.size).toBe(0);
  });

  it("does not badge a lone climber (nothing to stand out against)", () => {
    const trending = trendingPackIds([
      packWithTrend("only-climber", [0, 1, 2, 3]),
      packWithTrend("flat", [2, 2, 2, 2]),
    ]);

    expect(trending.size).toBe(0);
  });

  it("ignores packs with no trend data (e.g. list rows before analytics load)", () => {
    const trending = trendingPackIds([
      packWithoutTrend("no-data-a"),
      packWithoutTrend("no-data-b"),
    ]);

    expect(trending.size).toBe(0);
  });
});

describe("PackCard trending flag", () => {
  it("renders the Trending badge when the flag is set", () => {
    render(
      <PackCard
        context={createPacksContext(PacksMode.DesktopTeam)}
        onSelect={vi.fn()}
        pack={packWithTrend("fixture", [0, 1, 2, 3])}
        trending
      />
    );
    expect(screen.getByLabelText("Trending")).toBeDefined();
  });

  it("omits the badge when the flag is unset", () => {
    render(
      <PackCard
        context={createPacksContext(PacksMode.DesktopTeam)}
        onSelect={vi.fn()}
        pack={packWithTrend("fixture", [0, 1, 2, 3])}
      />
    );
    expect(screen.queryByLabelText("Trending")).toBeNull();
  });
});
