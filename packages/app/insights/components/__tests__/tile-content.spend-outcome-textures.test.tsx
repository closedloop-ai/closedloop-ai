/**
 * ISS-5362 (#4514, wongk): the PRODUCTION pass-through, end to end.
 *
 * The catalog test stops at the descriptor and the `DonutChart` tests supply
 * their own maps, so both stay green if `tile-content.tsx` never forwards the
 * texture props at all — the ring would ship with no non-colour channel and
 * nothing would go red. This file closes that gap the only way it can be
 * closed: mount the real tile content on the real catalog descriptor, render
 * the real `DonutChart`, and assert on what the ring actually DRAWS.
 *
 * Recharts' SVG layout does not measure inside jsdom, so its primitives are
 * stubbed exactly as the sibling `donut-chart.share-legend` test does — but
 * `<defs>` is passed through untouched, because the `<pattern>` elements are
 * the thing under test. Everything between the catalog and those patterns is
 * real: the descriptor, `InsightsChartContent`, and `DonutChart` itself.
 */

import { SpendOutcome } from "@closedloop-ai/loops-api/insights";
import type { CategoryBucket } from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import { donutSliceMarkColor } from "@repo/design-system/components/ui/donut-slice-textures";
import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  SPEND_OUTCOME_COLORS,
  SPEND_OUTCOME_TEXTURE_MARK_COLORS,
} from "../../lib/spend-outcome-palette";

const SLICE_FILL_ATTRIBUTE = "data-fill";
const TEXTURE_URL = /^url\(#donut-texture-.*\)$/;
/** `Clean` is the deliberately-flat bucket, so three of the four are textured. */
const TEXTURED_SLICE_COUNT = 3;

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    PieChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Pie: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Cell: ({ fill }: { fill: string }) => (
      <div data-fill={fill} data-testid="slice" />
    ),
    Legend: (_: { content: ReactElement }) => null,
  };
});

const { getTile } = await import("../../lib/tile-catalog");
const { InsightsChartContent } = await import("../tile-content");

const DONUT_TILE_ID = "chart:spendByOutcome:donut";

/** Every bucket non-zero, so every slice — and every texture — is drawn. */
const SPENT: CategoryBucket[] = [
  { key: SpendOutcome.Clean, label: "Ended clean", value: 45 },
  { key: SpendOutcome.Errored, label: "Ended with error", value: 15 },
  { key: SpendOutcome.Running, label: "Still running", value: 8 },
  { key: SpendOutcome.Unknown, label: "Not recorded", value: 32 },
];

function renderDonutTile() {
  const tile = getTile(DONUT_TILE_ID);
  if (!tile) {
    throw new Error(`Missing tile descriptor: ${DONUT_TILE_ID}`);
  }
  return render(
    <InsightsChartContent
      sections={{
        [InsightsSection.Agents]: {
          kpis: [],
          charts: {
            modelUsageOverTime: { series: [], points: [] },
            modelBreakdown: [],
            spendByOutcome: SPENT,
          },
        },
      }}
      tile={tile}
    />
  );
}

describe("spend-by-outcome ring: the non-colour channel reaches the DOM", () => {
  it("draws a pattern for every textured bucket the catalog assigns", () => {
    const { container } = renderDonutTile();

    // Three of the four buckets are textured (`Clean` stays flat on purpose).
    // Deleting `textureByKey` from the tile's `<DonutChart>` call drops this to
    // zero, which is the regression this file exists to catch.
    expect(container.querySelectorAll("pattern")).toHaveLength(
      TEXTURED_SLICE_COUNT
    );
  });

  it("points the textured slices at those patterns and leaves the flat one flat", () => {
    const { container } = renderDonutTile();

    const fills = [...container.querySelectorAll("[data-testid='slice']")].map(
      (node) => node.getAttribute(SLICE_FILL_ATTRIBUTE) ?? ""
    );
    const textured = fills.filter((fill) => TEXTURE_URL.test(fill));

    expect(textured).toHaveLength(TEXTURED_SLICE_COUNT);
    // Sharing one paint server would separate nothing, which is the defect.
    expect(new Set(textured).size).toBe(textured.length);
    // `Clean` is first in emission order and must keep its semantic colour.
    // Read from the shipped palette rather than restating its literal: the
    // claim under test is that the tile forwards the CATALOG's colour to the
    // flat slice, not which token that colour happens to be this month.
    expect(fills[0]).toBe(SPEND_OUTCOME_COLORS[SpendOutcome.Clean]);
  });

  it("draws each bucket's marks in the mark colour the shipped palette resolves", () => {
    const { container } = renderDonutTile();

    // #4514 (review): a texture whose marks cannot be seen on the slice they sit
    // on is not a channel, so the mark colour each bucket gets is part of the
    // contract, not an implementation detail. This reads it out of the DOM and
    // holds it to what the SHIPPED palette resolves rather than to a literal —
    // `spend-outcome-texture-contrast.test.ts` is what holds those resolved
    // values to the 3:1 floor.
    //
    // Post-ISS-5335 `SPEND_OUTCOME_TEXTURE_MARK_COLORS` is empty, so every
    // bucket resolves to the default card token today. That makes this a
    // weaker guard on `textureMarkColorByKey` FORWARDING than it was while an
    // override existed — with an empty map a tile that dropped the prop would
    // paint identically. It is deliberately written against the resolver rather
    // than against `var(--card)` so it becomes a real forwarding guard again the
    // moment any bucket takes an override, instead of having to be rewritten.
    const markColors = [...container.querySelectorAll("pattern")].map(
      (pattern) => ({
        id: pattern.getAttribute("id") ?? "",
        mark:
          pattern.querySelector("circle")?.getAttribute("fill") ??
          pattern.querySelector("path")?.getAttribute("stroke") ??
          "",
      })
    );

    expect(markColors).toHaveLength(TEXTURED_SLICE_COUNT);

    for (const entry of markColors) {
      const outcome = Object.values(SpendOutcome).find((candidate) =>
        entry.id.endsWith(candidate)
      );

      expect(outcome, `pattern id ${entry.id} names no bucket`).toBeDefined();
      expect(entry.mark, `${outcome} mark`).toBe(
        donutSliceMarkColor(SPEND_OUTCOME_TEXTURE_MARK_COLORS, outcome ?? "")
      );
    }
  });
});
