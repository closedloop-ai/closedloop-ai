"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useLocalStorageState } from "../../shared/hooks/use-local-storage-state";
import {
  type DashboardTileSettings,
  type GridPosition,
  gridPositionSchema,
  type SharedDashboard,
  tileSettingsSchema,
} from "../lib/dashboard-schema";
import {
  DEFAULT_DASHBOARD_TILE_IDS,
  getTile,
  REMOVED_DASHBOARD_TILE_IDS,
} from "../lib/tile-catalog";

export type {
  DashboardTileSettings,
  GridPosition,
  SharedDashboard,
} from "../lib/dashboard-schema";

const STORAGE_VERSION = 7;
const STORAGE_PREFIX = "closedloop:insights-dashboard:v1";
const REMOVED_TILE_IDS = new Set<string>(
  Object.values(REMOVED_DASHBOARD_TILE_IDS)
);
const ANALYTICS_PIE_TILE_IDS = [
  "chart:tokenDistribution",
  "chart:agentsByStatus",
  "chart:eventsByType",
  "chart:agentsByType:donut",
  "chart:toolUsage:donut",
  "chart:modelBreakdown:donut",
] as const;

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

export function useDashboardPins(
  namespace: string,
  sharedOverride?: SharedDashboard | null
): DashboardPins {
  const [stored, setStored] = useLocalStorageState<unknown>(
    `${STORAGE_PREFIX}:${namespace}`,
    defaultStored()
  );
  // Local, non-persisted edits made while previewing a shared dashboard. Kept
  // separate from localStorage so opening a `?dash=` link never overwrites the
  // recipient's own saved dashboard; it only seeds once the recipient edits.
  const [overrideEdits, setOverrideEdits] = useState<StoredPins | null>(null);

  // Discard the ephemeral edits whenever the active shared dashboard changes
  // identity (e.g. navigating `?dash=A` -> `?dash=B`). Otherwise the memo below
  // keeps returning dashboard A's edits — `overrideEdits` is non-null, so the
  // `?? normalizeSharedOverride` fallback never fires — and the recipient sees
  // A's edits painted onto B's snapshot. Resetting during render (rather than in
  // an effect) avoids a frame where the stale edits are shown over the new
  // snapshot.
  const previousSharedOverrideRef = useRef(sharedOverride);
  if (previousSharedOverrideRef.current !== sharedOverride) {
    previousSharedOverrideRef.current = sharedOverride;
    if (overrideEdits !== null) {
      setOverrideEdits(null);
    }
  }

  const value = useMemo<StoredPins>(() => {
    if (sharedOverride) {
      return overrideEdits ?? normalizeSharedOverride(sharedOverride);
    }
    return parseStoredPins(stored);
  }, [sharedOverride, overrideEdits, stored]);

  // Single write path: route edits to the ephemeral override copy while a
  // shared dashboard is active, otherwise persist to localStorage.
  const updatePins = useCallback(
    (updater: (current: StoredPins) => StoredPins) => {
      if (sharedOverride) {
        setOverrideEdits((prev) =>
          updater(prev ?? normalizeSharedOverride(sharedOverride))
        );
        return;
      }
      setStored((prev: unknown) => updater(parseStoredPins(prev)));
    },
    [sharedOverride, setStored]
  );

  const togglePin = useCallback(
    (id: string) => {
      updatePins((current) => {
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
    [updatePins]
  );

  const pinTile = useCallback(
    (id: string, settings: DashboardTileSettings = {}) => {
      updatePins((current) => {
        return {
          ...current,
          settings: { ...current.settings, [id]: settings },
          tiles: current.tiles.includes(id)
            ? current.tiles
            : [...current.tiles, id],
        };
      });
    },
    [updatePins]
  );

  const replaceTile = useCallback(
    (fromId: string, toId: string, settings: DashboardTileSettings = {}) => {
      updatePins((current) => {
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
    [updatePins]
  );

  const unpinTile = useCallback(
    (id: string) => {
      updatePins((current) => {
        const settings = { ...current.settings };
        Reflect.deleteProperty(settings, id);
        return {
          ...current,
          settings,
          tiles: current.tiles.filter((tile) => tile !== id),
        };
      });
    },
    [updatePins]
  );

  const setTileSettings = useCallback(
    (id: string, settings: DashboardTileSettings) => {
      updatePins((current) => {
        return {
          ...current,
          settings: { ...current.settings, [id]: settings },
        };
      });
    },
    [updatePins]
  );

  const setLayout = useCallback(
    (layout: Record<string, GridPosition>) => {
      updatePins((current) => {
        return { ...current, layout };
      });
    },
    [updatePins]
  );

  const resetToDefault = useCallback(() => {
    updatePins(() => defaultStored());
  }, [updatePins]);

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

// Project a shared dashboard snapshot into the internal StoredPins shape,
// running it through the same retired-tile cleanup as stored dashboards so a
// link that predates a tile removal can never resurrect a dead tile.
function normalizeSharedOverride(override: SharedDashboard): StoredPins {
  return removeRetiredTiles({
    version: STORAGE_VERSION,
    tiles: uniqueTileIds(override.tiles),
    layout: { ...override.layout },
    settings: { ...override.settings },
  });
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
    return removeRetiredTiles(parsed.data);
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
  return removeRetiredTiles({
    ...value,
    version: STORAGE_VERSION,
    layout: {},
    tiles: mergeTileIds(value.tiles, ANALYTICS_PIE_TILE_IDS),
  });
}

function migrateLayoutResetStoredPins(
  value: LayoutResetStoredPins
): StoredPins {
  return removeRetiredTiles({
    ...value,
    version: STORAGE_VERSION,
    layout: {},
  });
}

function migrateV6StoredPins(value: V6StoredPins): StoredPins {
  // Before the dashboard-grid lg-only persistence fix, committing a layout
  // edited at the collapsed sm breakpoint rewrote every tile into a single
  // full-width column (all positions at x:0). Reset only that corrupted shape
  // so customized, genuinely multi-column v6 layouts survive the upgrade.
  return removeRetiredTiles({
    ...value,
    version: STORAGE_VERSION,
    layout: isSingleColumnStack(value.layout) ? {} : value.layout,
  });
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

function removeRetiredTiles(value: StoredPins): StoredPins {
  return {
    ...value,
    layout: removeRetiredRecordEntries(value.layout),
    settings: removeRetiredRecordEntries(value.settings),
    tiles: value.tiles.filter((id) => !REMOVED_TILE_IDS.has(id)),
  };
}

function removeRetiredRecordEntries<T>(
  record: Record<string, T>
): Record<string, T> {
  const next = { ...record };
  for (const id of REMOVED_TILE_IDS) {
    Reflect.deleteProperty(next, id);
  }
  return next;
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
