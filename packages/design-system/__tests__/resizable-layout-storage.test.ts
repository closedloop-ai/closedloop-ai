import {
  createResizableLayoutStorage,
  isPersistedLayout,
  legacyLayoutStorageKey,
  migrateLegacyLayout,
} from "@closedloop-ai/design-system/components/ui/resizable-layout-storage";
import { afterEach, describe, expect, it } from "vitest";

/**
 * react-resizable-panels@3 → @4. v3 stored a group's layout as a POSITIONAL
 * array of percentages under `react-resizable-panels:<autoSaveId>`; v4 stores a
 * map of panel id to flexGrow. v4's own reader for the old shape recovers panel
 * ids by splitting the stored panel key on ",", which only works when every v3
 * panel carried an explicit `id` — the document editor's did not, so without
 * this migration every saved editor split silently resets on the first load
 * after the upgrade.
 */

const AUTO_SAVE_ID = "document-editor";
const PANEL_IDS = ["document-editor-body", "document-editor-chat"] as const;
const LEGACY_KEY = legacyLayoutStorageKey(AUTO_SAVE_ID);
const V4_KEY = `react-resizable-panels:${AUTO_SAVE_ID}:${PANEL_IDS.join(":")}`;

function legacyBlob(entries: Record<string, { layout: number[] }>): string {
  return JSON.stringify(entries);
}

afterEach(() => {
  globalThis.localStorage.clear();
});

describe("migrateLegacyLayout", () => {
  it("maps a v3 positional layout onto panel ids in render order", () => {
    const layout = migrateLegacyLayout(
      legacyBlob({
        '{"defaultSize":75,"minSize":50},{"maxSize":40,"minSize":15}': {
          layout: [72.5, 27.5],
        },
      }),
      PANEL_IDS
    );

    expect(layout).toEqual({
      "document-editor-body": 72.5,
      "document-editor-chat": 27.5,
    });
  });

  it("ignores an entry whose panel count does not match the group", () => {
    const layout = migrateLegacyLayout(
      legacyBlob({ '{"minSize":50}': { layout: [100] } }),
      PANEL_IDS
    );

    expect(layout).toBeUndefined();
  });

  it("selects the one entry matching this panel count, not the first", () => {
    const layout = migrateLegacyLayout(
      legacyBlob({
        '{"minSize":50}': { layout: [100] },
        '{"defaultSize":75},{"minSize":15}': { layout: [60, 40] },
      }),
      PANEL_IDS
    );

    expect(layout).toEqual({
      "document-editor-body": 60,
      "document-editor-chat": 40,
    });
  });

  it("refuses to guess when two stored entries have this panel count", () => {
    const layout = migrateLegacyLayout(
      legacyBlob({
        a: { layout: [60, 40] },
        b: { layout: [80, 20] },
      }),
      PANEL_IDS
    );

    expect(layout).toBeUndefined();
  });

  it.each([
    ["a negative size", [-10, 110]],
    ["a non-finite size", [Number.NaN, 50]],
    ["an all-zero layout", [0, 0]],
  ])("rejects %s rather than persisting it", (_label, sizes) => {
    const layout = migrateLegacyLayout(
      legacyBlob({ a: { layout: sizes } }),
      PANEL_IDS
    );

    expect(layout).toBeUndefined();
  });

  it("survives a value this library did not write", () => {
    expect(migrateLegacyLayout("not json", PANEL_IDS)).toBeUndefined();
    expect(migrateLegacyLayout("[1,2]", PANEL_IDS)).toBeUndefined();
  });
});

describe("isPersistedLayout", () => {
  it("accepts a v4 layout and rejects a v3 blob", () => {
    expect(isPersistedLayout(JSON.stringify({ a: 60, b: 40 }))).toBe(true);
    expect(isPersistedLayout(legacyBlob({ a: { layout: [60, 40] } }))).toBe(
      false
    );
  });
});

describe("createResizableLayoutStorage", () => {
  it("serves a migrated v3 layout when v4 has not written one yet", () => {
    globalThis.localStorage.setItem(
      LEGACY_KEY,
      legacyBlob({ a: { layout: [70, 30] } })
    );
    const storage = createResizableLayoutStorage(AUTO_SAVE_ID, PANEL_IDS);

    expect(JSON.parse(storage.getItem(V4_KEY) as string)).toEqual({
      "document-editor-body": 70,
      "document-editor-chat": 30,
    });
  });

  it("prefers the v4 layout once one exists", () => {
    globalThis.localStorage.setItem(
      LEGACY_KEY,
      legacyBlob({ a: { layout: [70, 30] } })
    );
    globalThis.localStorage.setItem(
      V4_KEY,
      JSON.stringify({
        "document-editor-body": 55,
        "document-editor-chat": 45,
      })
    );
    const storage = createResizableLayoutStorage(AUTO_SAVE_ID, PANEL_IDS);

    expect(JSON.parse(storage.getItem(V4_KEY) as string)).toEqual({
      "document-editor-body": 55,
      "document-editor-chat": 45,
    });
  });

  it("returns a referentially stable snapshot for useSyncExternalStore", () => {
    globalThis.localStorage.setItem(
      LEGACY_KEY,
      legacyBlob({ a: { layout: [70, 30] } })
    );
    const storage = createResizableLayoutStorage(AUTO_SAVE_ID, PANEL_IDS);

    expect(storage.getItem(V4_KEY)).toBe(storage.getItem(V4_KEY));
  });

  it("writes through to localStorage and reads its own write back", () => {
    const storage = createResizableLayoutStorage(AUTO_SAVE_ID, PANEL_IDS);
    const next = JSON.stringify({
      "document-editor-body": 50,
      "document-editor-chat": 50,
    });

    storage.setItem(V4_KEY, next);

    expect(globalThis.localStorage.getItem(V4_KEY)).toBe(next);
    expect(storage.getItem(V4_KEY)).toBe(next);
  });

  it("keeps the last complete layout when a declared panel is missing", () => {
    const storage = createResizableLayoutStorage(AUTO_SAVE_ID, PANEL_IDS);
    const complete = JSON.stringify({
      "document-editor-body": 75,
      "document-editor-chat": 25,
    });
    storage.setItem(V4_KEY, complete);

    storage.setItem(V4_KEY, JSON.stringify({ "document-editor-body": 100 }));

    expect(globalThis.localStorage.getItem(V4_KEY)).toBe(complete);
    expect(storage.getItem(V4_KEY)).toBe(complete);
  });

  it("reports no stored layout when nothing was ever saved", () => {
    const storage = createResizableLayoutStorage(AUTO_SAVE_ID, PANEL_IDS);

    expect(storage.getItem(V4_KEY)).toBeNull();
  });
});
