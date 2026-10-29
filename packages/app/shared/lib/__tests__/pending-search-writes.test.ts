import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentSearchForPath,
  recordPendingSearch,
  retainPendingSearchWrites,
  settlePendingSearch,
} from "../pending-search-writes";

const PATH = "/pending-search-writes-test";
const EPOCH = 1;
const LATER_EPOCH = 2;

afterEach(() => {
  vi.useRealTimers();
  settlePendingSearch(PATH, "reset-by-unmatched-snapshot", EPOCH);
});

describe("pending search writes", () => {
  it("R3: builds on the newest unreflected write until the router reports it", () => {
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&b=2");
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&b=2&c=3");

    expect(currentSearchForPath(PATH, "a=1", EPOCH)).toBe("a=1&b=2&c=3");
    expect(currentSearchForPath(PATH, "a=1&b=2", LATER_EPOCH)).toBe(
      "a=1&b=2&c=3"
    );
    settlePendingSearch(PATH, "a=1&b=2&c=3", LATER_EPOCH);
    expect(currentSearchForPath(PATH, "a=1&b=2&c=3", LATER_EPOCH)).toBe(
      "a=1&b=2&c=3"
    );
  });

  it("R3: every hook reading one router state sees the same queue, whatever copy of the params it holds", () => {
    recordPendingSearch(PATH, "tab=all", EPOCH, "tab=all&statuses=todo");

    expect(currentSearchForPath(PATH, "tab=all", EPOCH)).toBe(
      "tab=all&statuses=todo"
    );
    expect(currentSearchForPath(PATH, "tab=all", EPOCH)).toBe(
      "tab=all&statuses=todo"
    );
  });

  it("R4: a snapshot that is neither the base nor a queued write wins", () => {
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&b=2");

    expect(currentSearchForPath(PATH, "z=9", EPOCH)).toBe("z=9");
  });

  it("R4: reading is pure, so a read with a foreign snapshot leaves the queue intact", () => {
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&b=2");

    currentSearchForPath(PATH, "z=9", LATER_EPOCH);

    expect(currentSearchForPath(PATH, "a=1", EPOCH)).toBe("a=1&b=2");
  });

  it("R4: the base snapshot under a changed navigation epoch clears the queue once settled", () => {
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&b=2");

    expect(currentSearchForPath(PATH, "a=1", LATER_EPOCH)).toBe("a=1");
    settlePendingSearch(PATH, "a=1", LATER_EPOCH);

    expect(currentSearchForPath(PATH, "a=1", EPOCH)).toBe("a=1");
  });

  it("R4: with no adapter epoch a popstate counts as a navigation the writers did not make", () => {
    const release = retainPendingSearchWrites(PATH);
    recordPendingSearch(PATH, "a=1", null, "a=1&b=2");

    globalThis.window.dispatchEvent(new PopStateEvent("popstate"));

    expect(currentSearchForPath(PATH, "a=1", null)).toBe("a=1");
    release();
  });

  it("R4: with an adapter epoch a popstate alone does not clear the queue, the adapter's own counter does", () => {
    const release = retainPendingSearchWrites(PATH);
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&b=2");

    globalThis.window.dispatchEvent(new PopStateEvent("popstate"));

    expect(currentSearchForPath(PATH, "a=1", EPOCH)).toBe("a=1&b=2");
    release();
  });

  it("R4: history.length plays no part, so a same-URL navigation is told apart only by the epoch", () => {
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&b=2");
    globalThis.window.history.pushState(null, "", "/elsewhere");

    expect(currentSearchForPath(PATH, "a=1", EPOCH)).toBe("a=1&b=2");
    expect(currentSearchForPath(PATH, "a=1", LATER_EPOCH)).toBe("a=1");
  });

  it("R4: a write back to the base query leaves nothing pending", () => {
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&b=2");
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1");

    expect(currentSearchForPath(PATH, "a=1&b=2", EPOCH)).toBe("a=1&b=2");
    expect(currentSearchForPath(PATH, "a=1", EPOCH)).toBe("a=1");
  });

  it("R4: a write back to a queued query cuts the queue there, so a later outside navigation to a superseded query is read as the URL", () => {
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&x=1");
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&x=1&y=2");
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&x=1");

    settlePendingSearch(PATH, "a=1&x=1", EPOCH);
    expect(currentSearchForPath(PATH, "a=1&x=1&y=2", LATER_EPOCH)).toBe(
      "a=1&x=1&y=2"
    );
  });

  it("R4: a queued empty query is the newest write", () => {
    recordPendingSearch(PATH, "owners=ada", EPOCH, "");

    expect(currentSearchForPath(PATH, "owners=ada", EPOCH)).toBe("");
  });

  it("R4: a write the router never reflects stops shadowing once the last writer for the route unmounts", async () => {
    const releaseFirst = retainPendingSearchWrites(PATH);
    const releaseSecond = retainPendingSearchWrites(PATH);
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&b=2");

    releaseFirst();
    await Promise.resolve();
    expect(currentSearchForPath(PATH, "a=1", EPOCH)).toBe("a=1&b=2");
    releaseSecond();
    await Promise.resolve();

    expect(currentSearchForPath(PATH, "a=1", EPOCH)).toBe("a=1");
  });

  it("R4: a release followed by a retain in the same task keeps the queue", async () => {
    const release = retainPendingSearchWrites(PATH);
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&b=2");

    release();
    const retained = retainPendingSearchWrites(PATH);
    await Promise.resolve();

    expect(currentSearchForPath(PATH, "a=1", EPOCH)).toBe("a=1&b=2");
    retained();
  });

  it("R4: a write the router reflects arbitrarily late is still merged onto", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    const release = retainPendingSearchWrites(PATH);
    recordPendingSearch(PATH, "a=1", EPOCH, "a=1&b=2");

    vi.setSystemTime(new Date("2026-10-22T11:00:00Z"));

    expect(currentSearchForPath(PATH, "a=1", EPOCH)).toBe("a=1&b=2");
    release();
  });
});
