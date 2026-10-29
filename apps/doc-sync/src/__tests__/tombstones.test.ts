import { log } from "@repo/observability/log";
import { REALTIME_TOKEN_TTL_SECONDS } from "@repo/realtime-contract/token";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTombstones,
  DOC_SYNC_TOMBSTONE_EVICTED_EARLY_EVENT,
} from "../storage/tombstones";

const TTL_MS = REALTIME_TOKEN_TTL_SECONDS * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeClock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("createTombstones", () => {
  it("holds a name for the token TTL by default, and drops it after", () => {
    const clock = fakeClock();
    const tombstones = createTombstones({ now: clock.now });

    tombstones.add("org:artifact:PLN-1");
    clock.advance(TTL_MS - 1);
    expect(tombstones.has("org:artifact:PLN-1")).toBe(true);

    clock.advance(1);
    expect(tombstones.has("org:artifact:PLN-1")).toBe(false);
  });

  it("restarts a name's TTL when it is added again", () => {
    const clock = fakeClock();
    const tombstones = createTombstones({ ttlMs: 100, now: clock.now });

    tombstones.add("a");
    clock.advance(60);
    tombstones.add("a");
    clock.advance(60);

    expect(tombstones.has("a")).toBe(true);
  });

  it("expires an entry added before a re-added one", () => {
    const clock = fakeClock();
    const tombstones = createTombstones({ ttlMs: 100, now: clock.now });

    tombstones.add("a");
    clock.advance(10);
    tombstones.add("b");
    clock.advance(10);
    tombstones.add("a");
    clock.advance(95);

    expect(tombstones.has("b")).toBe(false);
    expect(tombstones.has("a")).toBe(true);
  });

  it("evicts the oldest entry past the cap and logs it", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const clock = fakeClock();
    const tombstones = createTombstones({ maxEntries: 2, now: clock.now });

    tombstones.add("a");
    clock.advance(1);
    tombstones.add("b");
    clock.advance(1);
    tombstones.add("c");

    expect(tombstones.has("a")).toBe(false);
    expect(tombstones.has("b")).toBe(true);
    expect(tombstones.has("c")).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.any(String), {
      event: DOC_SYNC_TOMBSTONE_EVICTED_EARLY_EVENT,
      documentName: "a",
    });
  });

  it("does not count expired entries toward the cap", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const clock = fakeClock();
    const tombstones = createTombstones({
      ttlMs: 10,
      maxEntries: 1,
      now: clock.now,
    });

    tombstones.add("a");
    clock.advance(10);
    tombstones.add("b");

    expect(tombstones.has("b")).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });
});
