import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createOrderedPageIdWindow,
  SESSION_HYDRATION_WINDOW,
  sessionHydrationWindows,
} from "../src/main/session/session-hydration-window.js";

/**
 * ISS-6895 — the two primitives that let a bounded read stop shortening its
 * answer. Both replace a truncation, so both are tested for the property the
 * truncation lacked: total coverage.
 */
describe("sessionHydrationWindows", () => {
  test("covers every id exactly once, in order, in windows no larger than the size", () => {
    const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);

    const windows = [...sessionHydrationWindows(ids, 100)];

    assert.deepEqual(
      windows.map((window) => window.length),
      [100, 100, 50]
    );
    assert.deepEqual(windows.flat(), ids);
  });

  test("defaults to the residency ceiling", () => {
    const ids = Array.from(
      { length: SESSION_HYDRATION_WINDOW + 1 },
      (_, index) => `id-${index}`
    );

    const windows = [...sessionHydrationWindows(ids)];

    assert.deepEqual(
      windows.map((window) => window.length),
      [SESSION_HYDRATION_WINDOW, 1]
    );
  });

  test("clamps a zero, negative, or non-finite window instead of dropping ids", () => {
    const ids = ["a", "b", "c"];

    // A zero or negative size would loop forever or slice nothing; NaN would
    // slice nothing. All three must still emit every id.
    for (const size of [0, -10, Number.NaN]) {
      assert.deepEqual(
        [...sessionHydrationWindows(ids, size)].flat(),
        ids,
        `window size ${size} lost ids`
      );
    }
  });

  test("emits exactly one window when the id count equals the size", () => {
    const ids = Array.from(
      { length: SESSION_HYDRATION_WINDOW },
      (_, index) => `id-${index}`
    );

    assert.deepEqual(
      [...sessionHydrationWindows(ids)].map((window) => window.length),
      [SESSION_HYDRATION_WINDOW],
      "an exact fit must not emit a trailing empty window"
    );
  });

  test("yields nothing for an empty id list", () => {
    assert.deepEqual([...sessionHydrationWindows([])], []);
  });
});

describe("createOrderedPageIdWindow", () => {
  const descending = (a: string, b: string): number => b.localeCompare(a);

  function candidates(
    count: number,
    prefix = "s"
  ): { id: string; key: string }[] {
    return Array.from({ length: count }, (_, index) => {
      const id = `${prefix}-${String(index).padStart(4, "0")}`;
      return { id, key: id };
    });
  }

  test("merging in windows yields the same page as sorting the whole set at once", () => {
    const all = candidates(400);
    const window = createOrderedPageIdWindow(60, descending);
    for (let start = 0; start < all.length; start += 37) {
      window.merge(all.slice(start, start + 37));
    }

    assert.deepEqual(
      window.pageIds(50, 10),
      [...all]
        .sort((a, b) => descending(a.key, b.key))
        .slice(50, 60)
        .map((entry) => entry.id),
      "the bounded buffer must agree with a single sort of the full population"
    );
  });

  test("keeps the resident entries bounded by capacity, not by the population", () => {
    const window = createOrderedPageIdWindow<string>(25, null);
    for (let start = 0; start < 500; start += 50) {
      window.merge(candidates(50, `batch-${start}`));
    }

    // Asking for far more than capacity can only return what is resident.
    assert.equal(window.pageIds(0, 1000).length, 25);
  });

  test("an unsorted read keeps the incoming window order", () => {
    const all = candidates(30);
    const window = createOrderedPageIdWindow<string>(10, null);
    window.merge(all.slice(0, 20));
    window.merge(all.slice(20));

    assert.deepEqual(
      window.pageIds(0, 10),
      all.slice(0, 10).map((entry) => entry.id)
    );
  });

  test("breaks ties on resolved position across window boundaries", () => {
    const window = createOrderedPageIdWindow(4, () => 0);
    window.merge([
      { id: "first", key: 0 },
      { id: "second", key: 0 },
    ]);
    window.merge([
      { id: "third", key: 0 },
      { id: "fourth", key: 0 },
    ]);

    assert.deepEqual(window.pageIds(0, 4), [
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  test("clamps a zero, negative, or non-finite capacity to a servable page", () => {
    for (const capacity of [0, -5, Number.NaN]) {
      const window = createOrderedPageIdWindow<string>(capacity, null);
      window.merge(candidates(3));
      assert.equal(
        window.pageIds(0, 1).length,
        1,
        `capacity ${capacity} produced an unservable page`
      );
    }
  });
});
