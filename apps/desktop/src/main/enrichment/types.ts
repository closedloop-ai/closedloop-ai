/**
 * What survives of the desktop enrichment contract.
 *
 * PLN-1535 M5 (D6) deleted the local enrichment sweep, its `gh` passes, and the
 * origin PR/branch lifecycle fetchers, and with them every type that only ever
 * described that machinery: the enrichment state/source/result vocabulary, the
 * LOC-stat shapes, the sweep pacing and lease constants, and the origin-fetch
 * result unions. Nothing outside the deleted modules referenced any of them.
 *
 * `PrState` stays because it is not enrichment vocabulary at all — it is the
 * lowercase `pull_requests.pr_state` / `artifacts.pr_state` column value, and
 * the local Insights reads compare against it (`local-insights.ts`). Keeping it
 * here rather than re-declaring it at the reader is what stopped an uppercase
 * `'MERGED'` comparison from silently matching zero rows once before.
 *
 * **`artifacts.pr_state` now has no writer.** The deleted `gh` passes were its
 * only ones, and they had already stopped running well before deletion — the
 * sweep's sole production trigger was a no-op stub — so nothing observable
 * changed here. But every reader of the column should read it as permanently
 * NULL rather than as "not refreshed yet": the desktop-local merge rate,
 * merged-PR counts, and merged LOC (`local-insights.ts`) are dark, and the
 * open-PR fallbacks in `pr-link-maintenance.ts` / `branch-pr-attribution.ts`
 * are now permanent rather than temporary. Whether Local mode should serve
 * those metrics from the cloud projection instead is an open product question,
 * not something the deletion decided.
 */
export const PrState = {
  Open: "open",
  Merged: "merged",
  Closed: "closed",
} as const;
export type PrState = (typeof PrState)[keyof typeof PrState];
