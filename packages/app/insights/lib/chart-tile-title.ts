import type { KpiStat, TimeSeries } from "@repo/api/src/types/insights";
import type { ChartTileDescriptor } from "./tile-catalog";

/**
 * ISS-5507 — the heading a chart tile renders, resolved against the RESPONSE
 * instead of taken from the catalog verbatim.
 *
 * A tile that declares {@link ChartTileDescriptor.titleSuffix} has a metric noun
 * the surfaces disagree on: `chart:klocTrend` is a MERGED-PR series on the cloud
 * dashboard and a CAPTURED-PR series on desktop. The producers already say which
 * they sent — the desktop series is labelled "KLOC captured", cloud's "KLOC
 * merged" — so the heading is built from that noun plus the tile's chart-shape
 * suffix. This is the same deference a KPI tile already pays its producer,
 * preferring `kpi.label` over the catalog title (see `KpiMetricTile`); without
 * it a card reads "KLOC merged over time" above a legend saying "KLOC captured".
 *
 * `chart` is the first source because it IS the legend the heading would
 * otherwise contradict. `kpis` is the second because a producer may legitimately
 * OMIT the series while still naming the metric — desktop drops `klocTrend`
 * entirely when no captured PR can be sized (ISS-5412), and that empty card
 * still needs the right noun over it. Every caller passes both — the heatmap's
 * sr-only grid name is resolved here too, off the same two sources, so it cannot
 * end up naming a different population than the heading printed above it. `kpis`
 * is optional only for a section that has not loaded, which carries neither.
 *
 * Falls back to the catalog `title` for a tile with no suffix, and while neither
 * source has loaded: a heading that is briefly the default beats one that
 * flickers in from nothing.
 */
export function chartTileTitle(
  tile: ChartTileDescriptor,
  chart: TimeSeries | undefined,
  kpis?: KpiStat[]
): string {
  if (!tile.titleSuffix) {
    return tile.title;
  }
  const metricLabel =
    chart?.series.find((series) => series.key === tile.metricKey)?.label ??
    kpis?.find((entry) => entry.key === tile.metricKey)?.label;
  return metricLabel ? `${metricLabel} ${tile.titleSuffix}` : tile.title;
}
