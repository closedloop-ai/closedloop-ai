import { describe, expect, it } from "vitest";
import { createTokenBucket } from "../token-bucket";

const BURST = 20;
const REFILL_PER_SECOND = 10;
const MS_PER_TOKEN = 1000 / REFILL_PER_SECOND;

describe("createTokenBucket", () => {
  it("spends the whole burst, refuses the next, and refills at the rate", () => {
    let nowMs = 0;
    const bucket = createTokenBucket(
      { burst: BURST, refillPerSecond: REFILL_PER_SECOND },
      () => nowMs
    );

    for (let spent = 0; spent < BURST; spent += 1) {
      expect(bucket.take()).toBe(true);
    }
    expect(bucket.take()).toBe(false);

    nowMs += MS_PER_TOKEN - 1;
    expect(bucket.take()).toBe(false);
    nowMs += 1;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it("never refills past the burst", () => {
    let nowMs = 0;
    const bucket = createTokenBucket(
      { burst: 2, refillPerSecond: 1000 },
      () => nowMs
    );
    nowMs += 60_000;

    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      false,
    ]);
  });
});
