/**
 * ISS-4463 (wongk, #4282): render the REAL `DonutChart` for the two visual modes
 * this PR added.
 *
 * The sibling `tile-content.spend-outcome` test mocks `DonutChart` away to prove
 * the tile passes the right props — which says nothing about what the component
 * then draws. These cases exercise the component itself, so the share-percentage
 * arithmetic and the semantic fills actually run.
 *
 * Recharts' SVG layout does not measure inside jsdom, so the chart primitives are
 * stubbed. Everything under test stays real: `DonutChart`'s own body (the total,
 * the largest-remainder share allocation, and the key→colour resolution), the
 * `ChartContainer` config it builds, and the real `ChartLegendContent` that reads
 * labels back out of that config.
 */

import { DonutSliceTexture } from "@repo/design-system/components/ui/donut-slice-textures";
import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { cloneElement, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";

type Slice = { key: string; label: string; value: number };

// Top-level per Ultracite's useTopLevelRegex: trailing "<n>%" on a legend entry.
const SHARE_SUFFIX = /(\d+)%$/;
// Any share suffix at all — asserts the bare-label mode prints none.
const ANY_SHARE = /\d+%/;
// Top-level per Ultracite's useTopLevelRegex: a Cell fill that dereferences a
// slice-texture <pattern> rather than painting a flat colour.
const TEXTURE_URL = /^url\(#donut-texture-.*\)$/;
const TEXTURE_URL_PREFIX = "url(#";

// The data recharts is handed, captured so the stubbed <Legend> can build the
// payload shape the real ChartLegendContent resolves its labels from. ISS-5335
// also captures the <Pie>'s stroke props, which are the slice separator.
const captured = vi.hoisted(() => ({
  data: [] as Slice[],
  stroke: undefined as string | undefined,
  strokeWidth: undefined as number | undefined,
}));

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    PieChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Pie: ({
      children,
      data,
      stroke,
      strokeWidth,
    }: {
      children: ReactNode;
      data: Slice[];
      stroke?: string;
      strokeWidth?: number;
    }) => {
      captured.data = data;
      captured.stroke = stroke;
      captured.strokeWidth = strokeWidth;
      return <div>{children}</div>;
    },
    Cell: ({ fill }: { fill: string }) => (
      <div data-fill={fill} data-testid="slice" />
    ),
    Legend: ({ content }: { content: ReactElement }) =>
      isValidElement(content)
        ? cloneElement(content, {
            // Mirrors the entry shape recharts' Pie legend emits: the datum
            // travels under `payload`, which is where the real
            // `getPayloadConfigFromPayload` reads the `key` nameKey from.
            payload: captured.data.map((slice) => ({
              value: slice.key,
              dataKey: slice.key,
              color: "var(--chart-1)",
              payload: slice,
            })),
          } as Record<string, unknown>)
        : null,
  };
});

const { DonutChart, DONUT_SLICE_SEPARATOR_COLOR, DONUT_SLICE_SEPARATOR_WIDTH } =
  await import("@repo/design-system/components/ui/donut-chart");

// Three EQUAL slices: each is exactly 33.33…%, so every share has the same
// fractional part and independent rounding floors all three to 33.
const EQUAL_THIRDS: Slice[] = [
  { key: "clean", label: "Ended clean", value: 10 },
  { key: "errored", label: "Ended with error", value: 10 },
  { key: "running", label: "Still running", value: 10 },
];

describe("DonutChart share legend (ISS-4463)", () => {
  it("prints shares that sum to 100 rather than rounding each slice away", () => {
    render(<DonutChart data={EQUAL_THIRDS} showSharePercent />);

    // The regression this guards: independently rounded thirds print 33/33/33,
    // which totals 99% against a ring the reader can see is full. The leftover
    // point is allocated to the first slice by largest remainder (ties break on
    // original order), so the legend reads 34/33/33.
    expect(screen.getByText("Ended clean 34%")).toBeInTheDocument();
    expect(screen.getByText("Ended with error 33%")).toBeInTheDocument();
    expect(screen.getByText("Still running 33%")).toBeInTheDocument();

    const printed = EQUAL_THIRDS.map((slice) => {
      const node = screen.getByText(
        (content) =>
          content.startsWith(`${slice.label} `) && SHARE_SUFFIX.test(content)
      );
      return Number(node.textContent?.match(SHARE_SUFFIX)?.[1] ?? 0);
    });
    expect(printed.reduce((sum, share) => sum + share, 0)).toBe(100);
  });

  it("leaves the legend labels bare when the share mode is off", () => {
    render(<DonutChart data={EQUAL_THIRDS} />);

    expect(screen.getByText("Ended clean")).toBeInTheDocument();
    expect(screen.queryByText(ANY_SHARE)).not.toBeInTheDocument();
  });

  it("paints each slice from the semantic map, falling back for unmapped keys", () => {
    render(
      <DonutChart
        colorByKey={{
          clean: "var(--chart-4)",
          errored: "var(--destructive)",
        }}
        data={EQUAL_THIRDS}
      />
    );

    const fills = screen
      .getAllByTestId("slice")
      .map((node) => node.getAttribute("data-fill"));
    // Mapped keys take their semantic colour — the failure bucket must never be
    // whatever token its position happens to draw.
    expect(fills[0]).toBe("var(--chart-4)");
    expect(fills[1]).toBe("var(--destructive)");
    // `running` is absent from the map: a PARTIAL map is documented as safe, so
    // it falls back to the index palette rather than rendering an empty fill.
    expect(fills[2]).toBe("var(--chart-3)");
  });

  it("renders the empty state instead of a legend when nothing was spent", () => {
    render(
      <DonutChart
        data={[{ key: "clean", label: "Ended clean", value: 0 }]}
        emptyMessage="No AI spend in this period"
        showSharePercent
      />
    );

    expect(screen.getByText("No AI spend in this period")).toBeInTheDocument();
    expect(screen.queryByTestId("slice")).not.toBeInTheDocument();
  });

  // ISS-5335 (review): the ring's own BOUNDARIES, which the per-slice contrast
  // floor does not cover. Every pair of the semantic map measures under 3:1
  // against each other in both themes, so no slice order makes all four
  // boundaries readable — the separator is what does. `chart.tsx` strips
  // recharts' default `#fff` sector stroke, so without this prop there is
  // nothing between two adjacent fills at all.
  it("separates adjacent slices with a card-coloured stroke", () => {
    render(<DonutChart data={EQUAL_THIRDS} />);

    expect(captured.stroke).toBe(DONUT_SLICE_SEPARATOR_COLOR);
    expect(captured.strokeWidth).toBe(DONUT_SLICE_SEPARATOR_WIDTH);
    // A zero-width separator would satisfy "has a stroke" while drawing nothing.
    expect(captured.strokeWidth).toBeGreaterThan(0);
    // Not the literal `chart.tsx` neutralises to transparent.
    expect(captured.stroke).not.toBe("#fff");
  });
});

/**
 * ISS-5362: the REDUNDANT, non-colour identity channel, exercised through the
 * real component rather than asserted on the map that feeds it.
 *
 * The tile-catalog test proves the four buckets are assigned four distinct
 * textures. That says nothing about whether the ring DRAWS them, or whether the
 * legend — the only place a reader learns what a texture means — draws them
 * too. Both halves are what make the channel real, so both are asserted here.
 */
describe("DonutChart slice textures (ISS-5362)", () => {
  const COLORS = {
    clean: "var(--success)",
    errored: "var(--destructive)",
    running: "var(--info)",
  };
  const TEXTURES = {
    clean: DonutSliceTexture.Solid,
    errored: DonutSliceTexture.Diagonal,
    running: DonutSliceTexture.Dots,
  };

  function swatchFor(label: string) {
    return screen.getByText(label).previousElementSibling;
  }

  it("fills a textured slice from a pattern and a solid slice from its colour", () => {
    render(
      <DonutChart
        colorByKey={COLORS}
        data={EQUAL_THIRDS}
        textureByKey={TEXTURES}
      />
    );

    const fills = screen
      .getAllByTestId("slice")
      .map((node) => node.getAttribute("data-fill"));
    // `clean` is Solid, so it must keep painting the flat semantic colour — a
    // pattern reference here would mean every slice got hatched.
    expect(fills[0]).toBe("var(--success)");
    expect(fills[1]).toMatch(TEXTURE_URL);
    expect(fills[2]).toMatch(TEXTURE_URL);
    // Two textured slices must not share one pattern, or they would render
    // identically and the channel would separate nothing.
    expect(fills[1]).not.toBe(fills[2]);
  });

  it("emits a pattern definition for each textured slice and none for solid", () => {
    const { container } = render(
      <DonutChart
        colorByKey={COLORS}
        data={EQUAL_THIRDS}
        textureByKey={TEXTURES}
      />
    );

    const patternIds = [...container.querySelectorAll("pattern")].map((node) =>
      node.getAttribute("id")
    );
    expect(patternIds).toHaveLength(2);
    // Every `url(#…)` a Cell points at must actually resolve to a definition;
    // a dangling reference renders as an unpainted slice, not as a fallback.
    for (const fill of screen
      .getAllByTestId("slice")
      .map((node) => node.getAttribute("data-fill") ?? "")
      .filter((fill) => TEXTURE_URL.test(fill))) {
      expect(patternIds).toContain(fill.slice(TEXTURE_URL_PREFIX.length, -1));
    }
  });

  it("mirrors the texture onto the legend swatch that explains it", () => {
    render(
      <DonutChart
        colorByKey={COLORS}
        data={EQUAL_THIRDS}
        textureByKey={TEXTURES}
      />
    );

    // The textured buckets carry a background image over their colour...
    expect(swatchFor("Ended with error")).toHaveStyle({
      backgroundImage: expect.stringContaining("repeating-linear-gradient"),
    });
    expect(swatchFor("Still running")).toHaveStyle({
      backgroundImage: expect.stringContaining("radial-gradient"),
    });
    // ...and the solid bucket stays a plain fill, so "flat" reads as its own
    // identity rather than as a texture that failed to render.
    expect(
      (swatchFor("Ended clean") as HTMLElement).style.backgroundImage
    ).toBe("");
  });

  it("scopes pattern ids per chart so two donuts on a page cannot collide", () => {
    // Both rings define a pattern for the same slice key. Without per-instance
    // scoping the second definition wins the document-global id and repaints
    // the first chart's slice with the second chart's colour.
    const { container } = render(
      <>
        <DonutChart
          colorByKey={COLORS}
          data={EQUAL_THIRDS}
          textureByKey={TEXTURES}
        />
        <DonutChart
          colorByKey={COLORS}
          data={EQUAL_THIRDS}
          textureByKey={TEXTURES}
        />
      </>
    );

    const patternIds = [...container.querySelectorAll("pattern")].map((node) =>
      node.getAttribute("id")
    );
    expect(patternIds).toHaveLength(4);
    expect(new Set(patternIds).size).toBe(patternIds.length);
  });

  it("leaves every slice solid when no texture map is supplied", () => {
    // The prop is opt-in: texture is only worth its visual noise on a ring whose
    // palette cannot separate its own slices, so every other donut is untouched.
    const { container } = render(
      <DonutChart colorByKey={COLORS} data={EQUAL_THIRDS} />
    );

    expect(container.querySelectorAll("pattern")).toHaveLength(0);
    for (const node of screen.getAllByTestId("slice")) {
      expect(node.getAttribute("data-fill")).not.toMatch(TEXTURE_URL);
    }
  });
});
