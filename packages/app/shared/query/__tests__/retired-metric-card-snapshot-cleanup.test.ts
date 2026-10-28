import { describe, expect, it } from "vitest";
import {
  clearRetiredMetricCardSnapshots,
  RETIRED_METRIC_CARD_SNAPSHOT_STORAGE_PREFIX,
} from "../retired-metric-card-snapshot-cleanup";

/**
 * ISS-9897 removed the metric-card snapshot reader. Removing a reader does not
 * remove the bytes an already-upgraded profile is carrying, and `localStorage`
 * expires nothing on its own, so this sweep is the only thing that reclaims
 * them. The cases below are an UPGRADED profile (entries resident, written by
 * the previous build) and a profile that never had any.
 */

function createStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

const UNRELATED_KEY = "closedloop.table-view.sessions";

describe("clearRetiredMetricCardSnapshots", () => {
  it("reclaims every retired entry in an upgraded profile, owner key included", () => {
    const storage = createStorage({
      [`${RETIRED_METRIC_CARD_SNAPSHOT_STORAGE_PREFIX}v2.sessions`]: "{}",
      [`${RETIRED_METRIC_CARD_SNAPSHOT_STORAGE_PREFIX}v1.branches`]: "{}",
      [`${RETIRED_METRIC_CARD_SNAPSHOT_STORAGE_PREFIX}owner`]: "org_1",
      [UNRELATED_KEY]: "{}",
    });

    expect(clearRetiredMetricCardSnapshots(storage)).toBe(3);

    expect(storage.length).toBe(1);
    expect(storage.getItem(UNRELATED_KEY)).toBe("{}");
  });

  it("leaves a profile that never wrote a snapshot untouched", () => {
    const storage = createStorage({ [UNRELATED_KEY]: "{}" });

    expect(clearRetiredMetricCardSnapshots(storage)).toBe(0);
    expect(storage.getItem(UNRELATED_KEY)).toBe("{}");
  });

  it("reports nothing reclaimed when the profile refuses to be read", () => {
    const storage = {
      get length(): number {
        throw new Error("access denied");
      },
      key: () => null,
      removeItem: () => undefined,
    } as unknown as Storage;

    expect(clearRetiredMetricCardSnapshots(storage)).toBe(0);
  });
});
