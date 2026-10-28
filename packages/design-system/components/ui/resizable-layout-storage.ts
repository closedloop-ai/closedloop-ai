import type { Layout, LayoutStorage } from "react-resizable-panels";

/**
 * react-resizable-panels@3 persisted a group's layout at
 * `react-resizable-panels:<autoSaveId>`, as a map of an opaque "panel key" to
 * `{ expandToSizes, layout: number[] }` — a POSITIONAL array of percentages.
 * v4 persists a `Layout`, a map of panel id to flexGrow. v4 ships its own
 * reader for the old shape, but it recovers the panel ids by splitting that
 * opaque panel key on ","; the key is only id-shaped when every panel carried
 * an explicit `id` prop under v3, and ours did not — theirs is serialized
 * constraint JSON, which contains commas of its own. So the built-in path
 * silently yields nothing and every saved layout resets on first load under v4.
 *
 * This shim closes that gap: it maps the stored positional array onto the panel
 * ids the group declares today, which is the same association v3 itself used
 * (`layout[i]` is the i-th panel, left to right). Percentages carry over
 * unchanged because flexGrow is proportional.
 */
const LEGACY_KEY_PREFIX = "react-resizable-panels:";

function parseObject(serialized: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A value this library did not write, or a truncated one. Not recoverable,
    // and not worth failing a render over — the group falls back to defaults.
  }
  return undefined;
}

function isValidSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** True when `serialized` is already a v4 `Layout` and needs no migration. */
export function isPersistedLayout(serialized: string): boolean {
  const parsed = parseObject(serialized);
  if (!parsed) {
    return false;
  }
  const values = Object.values(parsed);
  return values.length > 0 && values.every(isValidSize);
}

export function legacyLayoutStorageKey(autoSaveId: string): string {
  return `${LEGACY_KEY_PREFIX}${autoSaveId}`;
}

function legacySizesFor(
  entry: unknown,
  panelCount: number,
): readonly number[] | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { layout } = entry as { layout?: unknown };
  if (!Array.isArray(layout) || layout.length !== panelCount) {
    return undefined;
  }
  if (!layout.every(isValidSize)) {
    return undefined;
  }
  const sizes = layout as number[];
  return sizes.some((size) => size > 0) ? sizes : undefined;
}

/**
 * Convert a v3 blob into a v4 `Layout` for `panelIds`, in render order.
 *
 * Returns undefined rather than a guess when the blob holds several candidate
 * entries of the right arity — v3 kept one entry per panel COMBINATION, and
 * picking the wrong one would restore a layout the user never saw.
 */
export function migrateLegacyLayout(
  serialized: string,
  panelIds: readonly string[],
): Layout | undefined {
  if (panelIds.length === 0) {
    return undefined;
  }
  const parsed = parseObject(serialized);
  if (!parsed) {
    return undefined;
  }
  const candidates = Object.values(parsed)
    .map((entry) => legacySizesFor(entry, panelIds.length))
    .filter((sizes): sizes is readonly number[] => sizes !== undefined);
  if (candidates.length !== 1) {
    return undefined;
  }
  const sizes = candidates[0];
  const layout: Layout = {};
  panelIds.forEach((panelId, index) => {
    layout[panelId] = sizes[index] as number;
  });
  return layout;
}

function readRaw(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Storage can throw outright (Safari private browsing, blocked site data).
    return null;
  }
}

/**
 * A group's persisted layout is keyed by the panel set the group DECLARED, and
 * a caller may render fewer than it declared — the document editor's chat panel
 * has a visibility gate of its own inside the slot it is injected through. A
 * layout covering only the panels that happened to mount would then overwrite
 * the full one under the full set's key, and reopening the missing panel would
 * restore a split the user never chose. v3 could not hit this because it keyed
 * on the panels actually present; keeping the last COMPLETE layout is how that
 * behavior survives without the group having to predict its own children.
 */
function coversDeclaredPanels(
  serialized: string,
  panelIds: readonly string[]
): boolean {
  const parsed = parseObject(serialized);
  if (!parsed) {
    return false;
  }
  return panelIds.every((panelId) => isValidSize(parsed[panelId]));
}

/**
 * `LayoutStorage` for `useDefaultLayout` that (a) is safe to call during a
 * server render, where `localStorage` does not exist and v4's default storage
 * would throw, and (b) falls back to a migrated v3 layout when v4 has not
 * written one yet.
 *
 * Reads are memoized per key because `useDefaultLayout` drives
 * `useSyncExternalStore`, which re-renders forever if `getSnapshot` returns a
 * freshly built string each call.
 */
export function createResizableLayoutStorage(
  autoSaveId: string,
  panelIds: readonly string[],
): LayoutStorage {
  const cache = new Map<string, string | null>();

  function compute(key: string): string | null {
    const raw = readRaw(key);
    if (raw !== null && isPersistedLayout(raw)) {
      return raw;
    }
    const legacy = readRaw(legacyLayoutStorageKey(autoSaveId));
    if (legacy === null) {
      return null;
    }
    const migrated = migrateLegacyLayout(legacy, panelIds);
    return migrated ? JSON.stringify(migrated) : null;
  }

  return {
    getItem(key: string): string | null {
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const value = compute(key);
      cache.set(key, value);
      return value;
    },
    setItem(key: string, value: string): void {
      if (!coversDeclaredPanels(value, panelIds)) {
        return;
      }
      cache.set(key, value);
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // Quota or blocked storage: the in-memory cache still keeps this
        // session's layout consistent, it just will not outlive the tab.
      }
    },
  };
}
