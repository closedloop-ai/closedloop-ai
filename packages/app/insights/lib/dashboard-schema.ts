import { protoSafeRecord } from "@repo/lib/security/proto-safe-record";
import { z } from "zod";

/**
 * Derived from `gridPositionSchema`, not re-declared beside it (marisolashgrove
 * review, #6698): a hand-written twin four lines from the schema is the shape
 * that drifts. TypeScript cannot express "integer >= 1", so this buys the field
 * SET and not the bounds — `gridPositionSchema` stays the only thing that
 * enforces those, at every ingress.
 */
export type GridPosition = z.infer<typeof gridPositionSchema>;
export type DashboardTileSettings = {
  comparisonOverlay?: boolean;
};

/**
 * Portable dashboard snapshot exchanged through the Insights `?dash=` share
 * link — the pinned tiles, their grid layout, and per-tile settings, decoupled
 * from the localStorage envelope (version/migrations).
 */
export type SharedDashboard = {
  tiles: string[];
  layout: Record<string, GridPosition>;
  settings: Record<string, DashboardTileSettings>;
};

export const gridPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});

export const tileSettingsSchema = z.object({
  comparisonOverlay: z.boolean().optional(),
});

/**
 * Persisted tile layout, keyed by tile id. Read from localStorage and from the
 * `?dash=` share token, so keys arrive from outside the process (hence
 * `protoSafeRecord`, ISS-8565). One corrupt entry drops only that tile's saved
 * position — `buildLayout` then falls back to the tile's authored `grid` — and
 * never fails the whole record, which used to reset the dashboard to defaults.
 */
export const gridLayoutSchema = protoSafeRecord(
  z.string(),
  gridPositionSchema.optional().catch(undefined)
).transform(dropUndefinedEntries);

function dropUndefinedEntries<T>(
  record: Record<string, T | undefined>
): Record<string, T> {
  const kept: [string, T][] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      kept.push([key, value]);
    }
  }
  return Object.fromEntries(kept);
}
