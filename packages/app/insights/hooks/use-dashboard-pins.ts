"use client";

import { useCallback, useMemo } from "react";
import { z } from "zod";
import { useLocalStorageState } from "../../shared/hooks/use-local-storage-state";
import { DEFAULT_DASHBOARD_TILE_IDS, getTile } from "../lib/tile-catalog";

const STORAGE_VERSION = 7;
const STORAGE_PREFIX = "closedloop:insights-dashboard:v1";
const ANALYTICS_PIE_TILE_IDS = [
  "chart:tokenDistribution",
  "chart:sessionsByStatus",
  "chart:agentsByStatus",
  "chart:eventsByType",
  "chart:agentsByType:donut",
  "chart:toolUsage:donut",
  "chart:modelBreakdown:donut",
] as const;

export type GridPosition = { x: number; y: number; w: number; h: number };
export type DashboardTileSettings = {
  comparisonOverlay?: boolean;
};

const gridPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const tileSettingsSchema = z.object({
  comparisonOverlay: z.boolean().optional(),
});

const storedPinsSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  tiles: z.array(z.string()),
  layout: z.record(z.string(), gridPositionSchema),
  settings: z.record(z.string(), tileSettingsSchema).optional().default({}),
});

type StoredPins = z.infer<typeof storedPinsSchema>;

const analyticsBackfillStoredPinsSchema = storedPinsSchema.extend({
  version: z.union([z.literal(3), z.literal(4)]),
});

type AnalyticsBackfillStoredPins = z.infer<
  typeof analyticsBackfillStoredPinsSchema
>;

const layoutResetStoredPinsSchema = storedPinsSchema.extend({
  version: z.literal(5),
});

type LayoutResetStoredPins = z.infer<typeof layoutResetStoredPinsSchema>;

const v6StoredPinsSchema = storedPinsSchema.extend({
  version: z.literal(6),
});

type V6StoredPins = z.infer<typeof v6StoredPinsSchema>;

export type DashboardPins = {
  tiles: string[];
  layout: Record<string, GridPosition>;
  settings: Record<string, DashboardTileSettings>;
  isPinned: (id: string) => boolean;
  getTileSettings: (id: string) => DashboardTileSettings;
  pinTile: (id: string, settings?: DashboardTileSettings) => void;
  replaceTile: (
    fromId: string,
    toId: string,
    settings?: DashboardTileSettings
  ) => void;
  unpinTile: (id: string) => void;
  togglePin: (id: string) => void;
  setTileSettings: (id: string, settings: DashboardTileSettings) => void;
  setLayout: (layout: Record<string, GridPosition>) => void;
  resetToDefault: () => void;
};

export function useDashboardPins(namespace: string): DashboardPins {
  const [stored, setStored] = useLocalStorageState<unknown>(
    `${STORAGE_PREFIX}:${namespace}`,
    defaultStored()
  );

  const value = useMemo<StoredPins>(() => {
    return parseStoredPins(stored);
  }, [stored]);

  const togglePin = useCallback(
    (id: string) => {
      setStored((prev: unknown) => {
        const current = parseStoredPins(prev);
        if (current.tiles.includes(id)) {
          const settings = { ...current.settings };
          Reflect.deleteProperty(settings, id);
          return {
            ...current,
            settings,
            tiles: current.tiles.filter((tile) => tile !== id),
          };
        }
        return { ...current, tiles: [...current.tiles, id] };
      });
    },
    [setStored]
  );

  const pinTile = useCallback(
    (id: string, settings: DashboardTileSettings = {}) => {
      setStored((prev: unknown) => {
        const current = parseStoredPins(prev);
        return {
          ...current,
          settings: { ...current.settings, [id]: settings },
          tiles: current.tiles.includes(id)
            ? current.tiles
            : [...current.tiles, id],
        };
      });
    },
    [setStored]
  );

  const replaceTile = useCallback(
    (fromId: string, toId: string, settings: DashboardTileSettings = {}) => {
      setStored((prev: unknown) => {
        const current = parseStoredPins(prev);
        const settingsByTile = { ...current.settings };
        Reflect.deleteProperty(settingsByTile, fromId);
        settingsByTile[toId] = settings;

        const layout = { ...current.layout };
        const sourceLayout = layout[fromId];
        Reflect.deleteProperty(layout, fromId);
        const targetTile = getTile(toId);
        if (sourceLayout) {
          layout[toId] = targetTile
            ? {
                ...sourceLayout,
                h: targetTile.grid.h,
                w: Math.max(sourceLayout.w, targetTile.grid.w),
              }
            : sourceLayout;
        }

        const nextTiles = current.tiles.includes(fromId)
          ? current.tiles.map((tile) => (tile === fromId ? toId : tile))
          : [...current.tiles, toId];

        return {
          ...current,
          layout,
          settings: settingsByTile,
          tiles: uniqueTileIds(nextTiles),
        };
      });
    },
    [setStored]
  );

  const unpinTile = useCallback(
    (id: string) => {
      setStored((prev: unknown) => {
        const current = parseStoredPins(prev);
        const settings = { ...current.settings };
        Reflect.deleteProperty(settings, id);
        return {
          ...current,
          settings,
          tiles: current.tiles.filter((tile) => tile !== id),
        };
      });
    },
    [setStored]
  );

  const setTileSettings = useCallback(
    (id: string, settings: DashboardTileSettings) => {
      setStored((prev: unknown) => {
        const current = parseStoredPins(prev);
        return {
          ...current,
          settings: { ...current.settings, [id]: settings },
        };
      });
    },
    [setStored]
  );

  const setLayout = useCallback(
    (layout: Record<string, GridPosition>) => {
      setStored((prev: unknown) => {
        const current = parseStoredPins(prev);
        return { ...current, layout };
      });
    },
    [setStored]
  );

  const resetToDefault = useCallback(() => {
    setStored(defaultStored());
  }, [setStored]);

  const isPinned = useCallback(
    (id: string) => value.tiles.includes(id),
    [value.tiles]
  );

  const getTileSettings = useCallback(
    (id: string) => value.settings[id] ?? {},
    [value.settings]
  );

  return {
    tiles: value.tiles,
    layout: value.layout,
    settings: value.settings,
    isPinned,
    getTileSettings,
    pinTile,
    replaceTile,
    unpinTile,
    togglePin,
    setTileSettings,
    setLayout,
    resetToDefault,
  };
}

function defaultStored(): StoredPins {
  return {
    version: STORAGE_VERSION,
    tiles: [...DEFAULT_DASHBOARD_TILE_IDS],
    layout: {},
    settings: {},
  };
}

function parseStoredPins(value: unknown): StoredPins {
  const parsed = storedPinsSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  const analyticsBackfillParsed =
    analyticsBackfillStoredPinsSchema.safeParse(value);
  if (analyticsBackfillParsed.success) {
    return migrateAnalyticsBackfillStoredPins(analyticsBackfillParsed.data);
  }

  const layoutResetParsed = layoutResetStoredPinsSchema.safeParse(value);
  if (layoutResetParsed.success) {
    return migrateLayoutResetStoredPins(layoutResetParsed.data);
  }

  const v6Parsed = v6StoredPinsSchema.safeParse(value);
  if (v6Parsed.success) {
    return migrateV6StoredPins(v6Parsed.data);
  }

  return defaultStored();
}

function migrateAnalyticsBackfillStoredPins(
  value: AnalyticsBackfillStoredPins
): StoredPins {
  return {
    ...value,
    version: STORAGE_VERSION,
    layout: {},
    tiles: mergeTileIds(value.tiles, ANALYTICS_PIE_TILE_IDS),
  };
}

function migrateLayoutResetStoredPins(
  value: LayoutResetStoredPins
): StoredPins {
  return {
    ...value,
    version: STORAGE_VERSION,
    layout: {},
  };
}

function migrateV6StoredPins(value: V6StoredPins): StoredPins {
  // Before the dashboard-grid lg-only persistence fix, committing a layout
  // edited at the collapsed sm breakpoint rewrote every tile into a single
  // full-width column (all positions at x:0). Reset only that corrupted shape
  // so customized, genuinely multi-column v6 layouts survive the upgrade.
  return {
    ...value,
    version: STORAGE_VERSION,
    layout: isSingleColumnStack(value.layout) ? {} : value.layout,
  };
}

// A single-column stack — every tile pinned to column 0 — is the signature of
// the pre-fix corruption; a healthy multi-column dashboard places tiles at
// varying x. Requires at least two tiles so a lone full-width tile is not
// misread as corruption.
function isSingleColumnStack(layout: Record<string, GridPosition>): boolean {
  const positions = Object.values(layout);
  return (
    positions.length >= 2 && positions.every((position) => position.x === 0)
  );
}

function mergeTileIds(
  existing: readonly string[],
  incoming: readonly string[]
): string[] {
  const merged = [...existing];
  for (const id of incoming) {
    if (!merged.includes(id)) {
      merged.push(id);
    }
  }
  return merged;
}

function uniqueTileIds(ids: readonly string[]): string[] {
  const unique: string[] = [];
  for (const id of ids) {
    if (!unique.includes(id)) {
      unique.push(id);
    }
  }
  return unique;
}
