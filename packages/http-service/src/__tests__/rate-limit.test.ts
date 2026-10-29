import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpServiceErrorCode } from "../errors";
import { tokenBucketRateLimit } from "../rate-limit";

const LIMIT = { burst: 2, refillPerSecond: 1 };
const MS_PER_TOKEN = 1000;

function appWith(now: () => number, code?: string | null) {
  const app = new Hono();
  app.use(
    "*",
    tokenBucketRateLimit(LIMIT, now, code === undefined ? {} : { code })
  );
  app.get("/r", (c) => c.json({ ok: true }));
  return app;
}

describe("tokenBucketRateLimit", () => {
  it("admits the burst, answers the next 429 rate_limited, and refills at the rate", async () => {
    let nowMs = 0;
    const app = appWith(() => nowMs);

    expect((await app.request("/r")).status).toBe(200);
    expect((await app.request("/r")).status).toBe(200);
    const refused = await app.request("/r");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      code: HttpServiceErrorCode.RateLimited,
    });

    nowMs += MS_PER_TOKEN - 1;
    expect((await app.request("/r")).status).toBe(429);
    nowMs += 1;
    expect((await app.request("/r")).status).toBe(200);
  });

  it("answers an empty 429 when code is null", async () => {
    const app = appWith(() => 0, null);
    await app.request("/r");
    await app.request("/r");

    const refused = await app.request("/r");

    expect(refused.status).toBe(429);
    expect(await refused.text()).toBe("");
  });
});
