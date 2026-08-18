"use client";

import * as React from "react";
import { Cell, Pie, PieChart } from "recharts";
import { chartColor } from "./chart-colors";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "./chart";
import {
  type DonutSliceTexture,
  DonutSliceTextureDefs,
  donutSliceMarkColor,
  donutSliceTextureBackground,
  donutSliceTextureId,
  isTexturedSlice,
  LEGEND_SWATCH_TILE_PX,
  ownValue,
} from "./donut-slice-textures";

// FEA-4264: the <Pie> is fed with `nameKey="key"`, so the tooltip and legend
// resolve each slice by its key.
const DONUT_SERIES_KEY = "key";

/**
 * ISS-5335 (review): the hairline gap between slices.
 *
 * A ring of N slices has N boundaries, and every boundary is a pair of fills
 * butted straight against each other — `chart.tsx` deliberately neutralises
 * recharts' default white sector stroke
 * (`[&_.recharts-sector[stroke='#fff']]:stroke-transparent`), so without this
 * there is nothing between them. Measured on the spend-by-outcome map, all six
 * slice pairs sit between 1.03:1 and 2.11:1 in light and 1.20:1 and 2.25:1 in
 * dark — every pair below the 3:1 non-text floor, in both themes. That is a
 * property of a 4-colour semantic palette, not of the order the slices happen to
 * be in: no rotation can make an unreadable pair readable when EVERY pair is
 * unreadable, so a palette permutation cannot fix it and a separator can.
 *
 * `--card` is the surface the ring is drawn on, so the separator reads as a gap
 * rather than as a fifth colour, and it works on any palette: each slice is
 * already held to 3:1 against this exact token, so both sides of every boundary
 * clear the floor against the line between them by construction.
 *
 * Not `#fff`: that literal is the value `chart.tsx` strips, and it would be
 * wrong in dark anyway.
 */
export const DONUT_SLICE_SEPARATOR_COLOR = "var(--card)";
export const DONUT_SLICE_SEPARATOR_WIDTH = 2;

export type DonutDatum = {
  key: string;
  label: string;
  value: number;
};

/**
 * Donut (ring) chart composite for part-of-whole categorical data. Built on the
 * shared `chart.tsx` primitives + Recharts; framework-agnostic.
 */
export function DonutChart({
  data,
  emptyMessage = "No data",
  valueFormatter,
  colorByKey,
  textureByKey,
  textureMarkColorByKey,
  showSharePercent = false,
}: {
  data: DonutDatum[];
  emptyMessage?: string;
  // Formats the slice value shown in the tooltip (e.g. currency). Defaults to
  // the shared tooltip number formatting.
  valueFormatter?: (value: number) => string;
  // Fixed slice-key → color map, for a ring whose slices are SEMANTIC rather
  // than merely categorical (e.g. good / bad / unknown). Keys not present fall
  // back to the index palette, so a partial map is safe.
  colorByKey?: Readonly<Record<string, string>>;
  // ISS-5362: fixed slice-key → texture map, adding a REDUNDANT non-colour
  // channel for slice identity. A donut otherwise encodes category in hue
  // alone, which is the one channel a colour-vision deficiency removes. Opt-in,
  // because texture is only worth its visual noise on a ring whose palette
  // cannot separate its own slices under simulated CVD — see
  // `donut-slice-textures.tsx`. Keys not present render solid, so a partial map
  // is safe.
  textureByKey?: Readonly<Record<string, DonutSliceTexture>>;
  // ISS-5362 (#4514 review): per-slice override for the colour the texture
  // marks are drawn in. Marks default to the card token, which reads as gaps
  // punched in the slice — but a slice drawn faintly against that same card has
  // no ink to give up, so its marks would be invisible on exactly the bucket
  // that most needs a non-colour channel. Such a slice names a DARKER
  // achromatic colour here instead. Keys not present use the default.
  textureMarkColorByKey?: Readonly<Record<string, string>>;
  // Print each slice's share of the ring in its legend entry. A donut has no
  // on-screen denominator, so a chart whose question IS "what share?" otherwise
  // leaves the reader eyeballing the arc. Opt-in, so existing donuts that answer
  // a "how much?" question keep their plain legend.
  showSharePercent?: boolean;
}) {
  // Before the zero-total early return: a hook cannot sit behind a branch.
  // Scopes this chart's `<pattern>` ids so two donuts on one dashboard cannot
  // collide on a document-global id.
  const instanceId = React.useId();
  const total = data.reduce((sum, slice) => sum + slice.value, 0);
  if (total === 0) {
    return (
      <div className="grid h-full min-h-24 place-items-center rounded-md border border-dashed bg-muted/20 p-4 text-center text-muted-foreground text-xs">
        {emptyMessage}
      </div>
    );
  }

  // Bind each slice's palette color to its key up front so filtering out a
  // hidden slice never reshuffles the remaining slices' colors (color stays tied
  // to identity, not to post-filter index).
  // Shares are allocated across the whole ring rather than each rounded on its
  // own, so the printed percentages always add up to 100 — three equal slices
  // read 34/33/33, never three 33s against a ring that is visibly full.
  const shares = showSharePercent ? allocateShares(data, total) : [];
  const config: ChartConfig = {};
  const resolvedColorByKey: Record<string, string> = {};
  for (let i = 0; i < data.length; i++) {
    const slice = data[i];
    // OWN-key reads throughout: slice keys are server-supplied, so `?.[key]`
    // would resolve a bucket named `constructor` through `Object.prototype` and
    // hand this a function where a colour or a texture belongs.
    const color = ownValue(colorByKey, slice.key) ?? chartColor(i);
    const swatchTexture = donutSliceTextureBackground(
      ownValue(textureByKey, slice.key),
      color,
      {
        markColor: donutSliceMarkColor(textureMarkColorByKey, slice.key),
        // The swatch is a 12px box, the ring's band is 20px and up, so parity
        // has to be perceptual rather than literal px — see the tile constants.
        tilePx: LEGEND_SWATCH_TILE_PX,
      }
    );
    config[slice.key] = {
      label: showSharePercent
        ? `${slice.label} ${shares[i]}%`
        : slice.label,
      color,
      // Carry the texture to the legend swatch. A textured ring with a flat
      // legend would leave the reader nothing to map an arc back to.
      ...(swatchTexture ? { swatchTexture } : {}),
    };
    resolvedColorByKey[slice.key] = color;
  }

  return (
    <ChartContainer className="h-full w-full" config={config}>
      <PieChart>
        {textureByKey ? (
          <DonutSliceTextureDefs
            colorByKey={resolvedColorByKey}
            instanceId={instanceId}
            markColorByKey={textureMarkColorByKey}
            textureByKey={textureByKey}
          />
        ) : null}
        <ChartTooltip
          content={
            <ChartTooltipContent
              hideLabel
              nameKey={DONUT_SERIES_KEY}
              valueFormatter={valueFormatter}
            />
          }
        />
        <Pie
          data={data}
          dataKey="value"
          innerRadius="55%"
          nameKey={DONUT_SERIES_KEY}
          outerRadius="80%"
          stroke={DONUT_SLICE_SEPARATOR_COLOR}
          strokeWidth={DONUT_SLICE_SEPARATOR_WIDTH}
        >
          {data.map((slice) => (
            <Cell
              fill={
                isTexturedSlice(ownValue(textureByKey, slice.key))
                  ? `url(#${donutSliceTextureId(instanceId, slice.key)})`
                  : resolvedColorByKey[slice.key]
              }
              key={slice.key}
            />
          ))}
        </Pie>
        {/* FEA-4264 (thread #1): the donut legend is intentionally STATIC, not
            click-to-toggle. A donut is part-to-whole with no on-screen
            denominator, so hiding a slice would renormalize the ring and make
            the survivors silently misread as a larger share of the whole. Only
            the time-series area chart — whose y-axis is labeled and rescales
            visibly — gets interactive hide/show. */}
        <ChartLegend
          content={
            <ChartLegendContent interactive={false} nameKey={DONUT_SERIES_KEY} />
          }
        />
      </PieChart>
    </ChartContainer>
  );
}

const PERCENT_SCALE = 100;

/**
 * Whole-percent shares for every slice, summing to exactly 100.
 *
 * Rounding each slice independently does not conserve the whole — three equal
 * slices each round to 33, printing 99% against a ring the reader can see is
 * full, and the discrepancy is worst precisely when the slices are close enough
 * that the reader is relying on the numbers rather than the arcs. So the
 * remainder is allocated by largest fractional part, the same rule the server
 * uses to allocate spend to cents.
 *
 * `total` is non-zero at every call site (the zero-total case renders the empty
 * state before the legend is built), but the guard keeps this total rather than
 * emitting `NaN%` if that ever stops holding.
 */
function allocateShares(data: DonutDatum[], total: number): number[] {
  if (total === 0) {
    return data.map(() => 0);
  }
  const exact = data.map((slice) => (slice.value / total) * PERCENT_SCALE);
  const floors = exact.map((value) => Math.floor(value));
  let leftover = PERCENT_SCALE - floors.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - floors[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const shares = [...floors];
  for (const { index } of byRemainder) {
    if (leftover <= 0) {
      break;
    }
    shares[index] += 1;
    leftover -= 1;
  }
  return shares;
}
