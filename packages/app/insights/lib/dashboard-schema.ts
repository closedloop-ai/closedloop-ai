import { z } from "zod";

export type GridPosition = { x: number; y: number; w: number; h: number };
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
  w: z.number(),
  h: z.number(),
});

export const tileSettingsSchema = z.object({
  comparisonOverlay: z.boolean().optional(),
});
