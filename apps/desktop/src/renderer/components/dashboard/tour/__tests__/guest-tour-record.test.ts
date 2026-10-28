/**
 * ISS-9728 — the persisted record that decides whether a reader with no account
 * is still owed the Dashboard tour.
 *
 * The whole subject is ONE asymmetry: only an explicit dismissal may suppress,
 * and everything else — never written, cleared, unreadable, or written by some
 * other build — is FIRST RUN. There is no server record for a guest that could
 * correct a wrong answer here, and the arm this feeds spends the install's one
 * shot, so a fold in the other direction retires the tour permanently for the
 * exact cohort its Create-account beat was written for.
 *
 * The store is driven through `globalThis.localStorage` rather than a stubbed
 * module seam, because the production read reaches the real global and a seam
 * would let this suite pass against a reader that never touches storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_FLAG_SET,
  dashboardTourSeenStorageKey,
} from "../../dashboard-storage-keys";
import {
  DashboardTourRecord,
  readDashboardTourRecord,
} from "../guest-tour-record";

/** The in-memory store the passing cases run against, plus its call log. */
function stubStore(seed?: string) {
  const store = new Map<string, string>();
  if (seed !== undefined) {
    store.set(dashboardTourSeenStorageKey, seed);
  }
  const setItem = vi.fn((key: string, value: string) => {
    store.set(key, value);
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem,
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  });
  return { setItem, store };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readDashboardTourRecord — only a dismissal suppresses", () => {
  it("reads an install that was shown the tour and ended it as dismissed", () => {
    // The positive half of every negative case below. Without it, a reader that
    // answered `FirstRun` unconditionally would pass the whole rest of the file.
    stubStore(DASHBOARD_FLAG_SET);

    expect(readDashboardTourRecord()).toBe(DashboardTourRecord.Dismissed);
  });

  it("reads a fresh install as first run", () => {
    stubStore();

    expect(readDashboardTourRecord()).toBe(DashboardTourRecord.FirstRun);
  });

  it("reads a cleared store as first run", () => {
    // Reaches the same `getItem` → null read as the fresh install above, by a
    // different history: this install DID hold a record and no longer does,
    // which is what a profile wipe or a reader clearing site data leaves. Kept
    // rather than deleted as a duplicate because the read is memoized at the
    // call site (`useState` initializer), and the obvious next optimisation is
    // to memoize it here too — at which point "cleared" stops answering like
    // "never written" and only this case says so.
    stubStore(DASHBOARD_FLAG_SET);
    localStorage.removeItem(dashboardTourSeenStorageKey);

    expect(readDashboardTourRecord()).toBe(DashboardTourRecord.FirstRun);
  });

  // Every value that is NOT the marker: a legacy or future spelling, a JSON
  // record where a scalar belongs, a hand edit, and the empty string, which is
  // the one a truthiness test would get wrong in the same direction as `"0"`.
  const CORRUPT_VALUES = ["0", "true", "yes", '{"seen":true}', "", " 1"];

  it.each(CORRUPT_VALUES)(
    "reads the unparseable record %j as first run",
    (value) => {
      stubStore(value);

      expect(readDashboardTourRecord()).toBe(DashboardTourRecord.FirstRun);
    }
  );

  it("reads a store that cannot answer as first run", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: vi.fn(),
    });

    expect(readDashboardTourRecord()).toBe(DashboardTourRecord.FirstRun);
  });

  it("leaves an unparseable record exactly as it found it", () => {
    // Normalising a bad record on read is what turns "we could not tell" into a
    // confident answer on the NEXT launch — and the only write this key may ever
    // take is the tour actually closing.
    const { setItem, store } = stubStore('{"seen":true}');

    expect(readDashboardTourRecord()).toBe(DashboardTourRecord.FirstRun);
    expect(setItem).not.toHaveBeenCalled();
    expect(store.get(dashboardTourSeenStorageKey)).toBe('{"seen":true}');
  });
});
