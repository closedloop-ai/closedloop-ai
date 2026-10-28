import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_JOB,
  env,
  INTERVAL_JOB,
  MINTED_SECRET_PATTERN,
  okResponse,
} from "@/__tests__/support/lib/dev-cron-scheduler.test-fixtures";
import {
  DEV_CRON_ENABLE_ENV_VAR,
  DevCronDisabledReason,
  startDevCronScheduler,
  TICK_TIMEOUT_MS,
} from "../dev-cron-scheduler";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("startDevCronScheduler (ISS-8152)", () => {
  // Every tick here calls `resolveCronSecret`, which MINTS into the real
  // `process.env` when the variable is unset — so this suite mutates it
  // indirectly, through the module under test, and owes the same exact
  // restoration a direct mutation would (#6048 review).
  let previousCronSecret: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    previousCronSecret = process.env.CRON_SECRET;
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(() => {
    if (previousCronSecret === undefined) {
      // Assigning `undefined` would store the STRING "undefined".
      Reflect.deleteProperty(process.env, "CRON_SECRET");
    } else {
      process.env.CRON_SECRET = previousCronSecret;
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("arms nothing when the guard refuses, and its handle is still safe to stop", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env({ NODE_ENV: "production" }),
      jobs: [BOOT_JOB, INTERVAL_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
  });

  it("runs the boot job immediately and makes the interval job wait", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(okResponse()));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB, INTERVAL_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(calledPaths(fetchImpl)).toEqual(["/cron/boot-job"]);

    await vi.advanceTimersByTimeAsync(500);
    expect(calledPaths(fetchImpl)).toContain("/cron/interval-job");

    handle.stop();
  });

  it("calls the route over loopback on the port it was given", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(okResponse()));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 4123,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4123/cron/boot-job"
    );
    handle.stop();
  });

  it("does not arm the next tick until the previous one settles", async () => {
    // Both routes declare `maxDuration = 300`, so an interval shorter than a
    // slow sweep would stack concurrent sweeps against one credential pool.
    let release: (() => void) | undefined;
    const inFlight = new Promise<Response>((resolve) => {
      release = () => resolve(okResponse());
    });
    // Only the FIRST tick hangs; later ticks get their own Response, because
    // production consumes the body and a shared instance would make tick 2 throw
    // "Body is unusable" and silently take the error path (#6048 review).
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => inFlight)
      .mockImplementation(() => Promise.resolve(okResponse()));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Far past the interval, with the first tick still open.
    await vi.advanceTimersByTimeAsync(BOOT_JOB.intervalMs * 5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(BOOT_JOB.intervalMs);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("bounds every tick with an abort signal, so a stalled request cannot stop the job", async () => {
    // davetho, #6048: the re-arm fires from `finally`, which is what makes
    // non-overlap structural — and also means a tick that never settles stops
    // that job forever. The local `node:http` server enforces none of Vercel's
    // `maxDuration`, so the signal is the only thing that ends it.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(okResponse()));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Presence alone passed under a mutant setting the timeout to 0, to 1ms, or
    // to a controller that never fires, while the constant is documented as
    // load-bearing for liveness (#6048 review). The deadline itself cannot be
    // driven here — `AbortSignal.timeout` runs on a native timer that vitest's
    // fake clock does not intercept — so the VALUE is pinned instead, against
    // the `maxDuration = 300` both cron routes declare.
    expect(TICK_TIMEOUT_MS).toBe(300 * 1000);
    handle.stop();
  });

  it("re-arms after a tick that aborts, rather than stalling that job", async () => {
    const aborted = new DOMException("timed out", "TimeoutError");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(aborted)
      .mockImplementation(() => Promise.resolve(okResponse()));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(BOOT_JOB.intervalMs);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("keeps ticking after a failed request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockImplementation(() => Promise.resolve(okResponse()));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BOOT_JOB.intervalMs);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("reports a successful tick without raising it to a warning", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(okResponse("OK: swept 3, wrote 7"))
      );

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);

    // The summary the route returned is what a developer reads to know the
    // stack is ingesting; a scheduler that logged every tick as a warning would
    // be as unreadable as one that logged nothing.
    expect(
      vi
        .mocked(log.info)
        .mock.calls.some(([line]) =>
          String(line).includes("OK: swept 3, wrote 7")
        )
    ).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    handle.stop();
  });

  it("offers no remedy for a 401, because the per-tick read makes one impossible", async () => {
    // The earlier "restart the API" advice described a failure this design
    // cannot produce: the header and the route read the same `process.env`
    // value per tick / per request, in one process (#6048 review).
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response("Unauthorized", { status: 401 }))
      );

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(log.warn).mock.calls[0]?.[1]).toMatchObject({
      remedy: undefined,
    });
    handle.stop();
  });

  it("points a 404 at the job table, the thing that actually went stale", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response("Not Found", { status: 404 }))
      );

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(log.warn).mock.calls[0]?.[1]).toMatchObject({
      remedy: expect.stringContaining("DEV_CRON_JOBS"),
    });
    handle.stop();
  });

  it("says why a tick failed, not just that the schedule survived it", async () => {
    // The re-arm test proves liveness but passes with an empty catch, which
    // would leave a developer watching a silent scheduler do nothing.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:3002"));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(log.warn).mock.calls[0]?.[1]).toMatchObject({
      error: expect.stringContaining("ECONNREFUSED"),
    });
    handle.stop();
  });

  it("does not re-arm when stopped while a tick is still in flight", async () => {
    // `stop` clears armed timers, so the `stopped` flag only matters in this
    // window — which every earlier stop test skipped by stopping between ticks.
    let release: (() => void) | undefined;
    const inFlight = new Promise<Response>((resolve) => {
      release = () => resolve(okResponse());
    });
    // Only the FIRST tick hangs; later ticks get their own Response, because
    // production consumes the body and a shared instance would make tick 2 throw
    // "Body is unusable" and silently take the error path (#6048 review).
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => inFlight)
      .mockImplementation(() => Promise.resolve(okResponse()));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    handle.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(BOOT_JOB.intervalMs * 3);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not blame the secret for a 500 that is some other failure", async () => {
    // Every unhandled exception in these routes is also a 500. Sending someone
    // to edit local.env when a service threw wastes the one diagnostic the tick
    // line carries, so the remedy matches on the body (#6048 review).
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response("reconcile-pull-requests failed", { status: 500 })
        )
      );

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(log.warn).mock.calls[0]?.[1]).toMatchObject({
      remedy: undefined,
    });
    handle.stop();
  });

  it("names the remedy when the route answers 500 for a missing CRON_SECRET", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response("Internal Server Error", { status: 500 }))
      );

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(log.warn).mock.calls[0]?.[1]).toMatchObject({
      remedy: expect.stringContaining("did not reach the route"),
    });
    handle.stop();
  });

  it("stops ticking once stopped", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(okResponse()));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB, INTERVAL_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    const afterBoot = fetchImpl.mock.calls.length;

    handle.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchImpl).toHaveBeenCalledTimes(afterBoot);
  });

  it("unrefs every armed timer so a tick cannot hold the process open", async () => {
    // Without this a Ctrl-C or a `tsx watch` restart waits on the scheduler,
    // which a developer will attribute to anything but this module.
    const unrefCalls: number[] = [];
    stubUnrefRecordingSetTimeout(unrefCalls);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(okResponse()));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB, INTERVAL_JOB],
      fetchImpl,
    });

    // One per job, armed at start.
    expect(unrefCalls).toHaveLength(2);

    // And the re-armed timer too, not just the first pair.
    await vi.advanceTimersByTimeAsync(0);
    expect(unrefCalls.length).toBeGreaterThan(2);

    handle.stop();
  });

  it("logs a banner that names the cadence as development and the database it targets", () => {
    startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(okResponse())),
    }).stop();

    const banner = String(vi.mocked(log.info).mock.calls[0]?.[0]);
    expect(banner).toContain("DEV CADENCE, NOT PROD");
    expect(banner).toContain(BOOT_JOB.cadenceLabel);
    expect(banner).toContain(BOOT_JOB.productionCadenceLabel);
    expect(banner).toContain("localhost");
  });

  it("warns when an operator asked for it and was refused", () => {
    startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env({ NODE_ENV: "production" }),
      jobs: [BOOT_JOB],
      fetchImpl: vi.fn<typeof fetch>(),
    }).stop();

    expect(vi.mocked(log.warn).mock.calls[0]?.[1]).toMatchObject({
      reason: DevCronDisabledReason.ProductionRuntime,
    });
  });

  it("says nothing at all when nobody opted in", () => {
    // Every production container boot takes this path. A permanent
    // "dev-cron disabled" line in production logs would be pure noise.
    const withoutOptIn = env();
    Reflect.deleteProperty(withoutOptIn, DEV_CRON_ENABLE_ENV_VAR);

    startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: withoutOptIn,
      jobs: [BOOT_JOB],
      fetchImpl: vi.fn<typeof fetch>(),
    }).stop();

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("the loopback bearer (ISS-8152)", () => {
  let previousCronSecret: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    previousCronSecret = process.env.CRON_SECRET;
  });

  afterEach(() => {
    if (previousCronSecret === undefined) {
      // Assigning `undefined` would store the STRING "undefined".
      Reflect.deleteProperty(process.env, "CRON_SECRET");
    } else {
      process.env.CRON_SECRET = previousCronSecret;
    }
    vi.useRealTimers();
  });

  it("presents an operator-configured CRON_SECRET unchanged", async () => {
    process.env.CRON_SECRET = "operator-configured-secret";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(okResponse()));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(authorizationOf(fetchImpl)).toBe(
      "Bearer operator-configured-secret"
    );
    handle.stop();
  });

  it("mints one when the environment has none, because these routes 500 without it", async () => {
    Reflect.deleteProperty(process.env, "CRON_SECRET");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(okResponse()));

    const handle = startDevCronScheduler({
      address: null,
      fallbackPort: 3002,
      env: env(),
      jobs: [BOOT_JOB],
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);

    const minted = process.env.CRON_SECRET;
    expect(minted).toMatch(MINTED_SECRET_PATTERN);
    // The route reads `process.env.CRON_SECRET` per request, so the header and
    // the environment must carry the same value or every tick 401s.
    expect(authorizationOf(fetchImpl)).toBe(`Bearer ${minted}`);
    handle.stop();
  });
});

function calledPaths(fetchImpl: ReturnType<typeof vi.fn>): string[] {
  return fetchImpl.mock.calls.map((call) => new URL(String(call[0])).pathname);
}

function authorizationOf(
  fetchImpl: ReturnType<typeof vi.fn>
): string | undefined {
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.authorization;
}

/**
 * Wrap `setTimeout` so each armed timer records whether `unref` was called on
 * it. Defines `unref` when the fake-timer implementation omits it, so the
 * recorder is what the module's optional call reaches either way — the
 * assertion still fails if the module stops calling it.
 */
function stubUnrefRecordingSetTimeout(unrefCalls: number[]): void {
  const inner = globalThis.setTimeout;
  vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
    const timer = inner(...args) as ReturnType<typeof setTimeout>;
    const originalUnref =
      typeof timer.unref === "function" ? timer.unref.bind(timer) : undefined;
    timer.unref = () => {
      unrefCalls.push(unrefCalls.length);
      return originalUnref ? originalUnref() : timer;
    };
    return timer;
  }) as unknown as typeof setTimeout);
}
