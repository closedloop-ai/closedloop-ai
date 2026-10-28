/**
 * ISS-5523: the single cross-surface flag key that gates distinguishable series
 * colors on the categorical time-series charts.
 *
 * The defect it fronts: a chart handed more series than the categorical palette
 * has slots cycled the palette, so unrelated series rendered in identical fills.
 * On agent detail's "Usage over time" that meant 17 model series drawn through
 * 10 colors — the legend could not resolve which band was which, because color
 * was the only thing telling them apart. ON, each chart draws at most one series
 * per distinguishable color and folds the remainder into a single neutral
 * "Other (N)" band; OFF, every chart renders exactly as it does today.
 *
 * ONE key across every model-series chart, deliberately. The dashboard row, the
 * dashboard tile, and the agent-detail trend all draw the same per-model series
 * through the same component; gating them separately would leave one surface
 * cycling the palette while its neighbour did not, which is the cross-surface
 * contradiction this change exists to remove.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop renderer resolves the byte-for-byte-equal key from the
 *    signed-in account's PostHog assignment, delivered over the IPC bridge,
 *    under the alias `DESKTOP_CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags-labs-detail.ts`).
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition — it can't silently split the two surfaces' reads of it the way
 * two parallel string literals could.
 */
export const CHART_DISTINGUISHABLE_SERIES_FLAG_KEY =
  "chart-distinguishable-series" as const;
