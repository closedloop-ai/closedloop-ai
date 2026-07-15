import { z } from "zod";

/**
 * FEA-3120 (PRD-525 Priority 2, DoD #6): the explicit provenance of a rendered
 * read surface — which store actually produced the rows a Sessions/Branches view
 * is showing right now. Surfaced so QA (and support) can tell a data bug from a
 * sync gap: a wrong number read from `Local` SQLite is a collector/query bug,
 * the same number read from `Cloud` is a backend/projection bug, and a `Fallback`
 * render means neither the local nor the cloud read succeeded and the surface is
 * showing a degraded/empty best-effort result.
 *
 * This is deliberately a small, additive discriminator that sits alongside the
 * existing sync-state enums (e.g. `BranchCloudHydrationStatus`, `BranchDataState`,
 * `BranchRefreshStatus`) rather than replacing them: those describe how fresh a
 * given store's data is; `ReadSource` describes which store the caller read from.
 * A surface can be `Cloud` + stale, or `Local` + fresh — the two axes compose.
 */
export const ReadSource = {
  /** Rendered from the desktop's local SQLite via IPC (no network). */
  Local: "local",
  /** Rendered from synced cloud state via the authenticated `apps/api` routes. */
  Cloud: "cloud",
  /**
   * Neither the primary local nor cloud read produced usable rows, so the surface
   * is showing a degraded/best-effort result (typically empty). A `fallback` read
   * is never silently mixed with real rows — it flags that the source is unknown
   * or unavailable, so a "wrong" number reads as a sync/availability gap.
   */
  Fallback: "fallback",
} as const;
export type ReadSource = (typeof ReadSource)[keyof typeof ReadSource];

export const readSourceValues = Object.values(ReadSource) as [
  ReadSource,
  ...ReadSource[],
];

export const readSourceSchema = z.enum(readSourceValues);

/** Type guard: narrows an arbitrary value to a known `ReadSource`. */
export function isReadSource(value: unknown): value is ReadSource {
  return (
    typeof value === "string" &&
    (readSourceValues as readonly string[]).includes(value)
  );
}
