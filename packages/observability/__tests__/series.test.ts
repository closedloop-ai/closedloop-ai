// Direct coverage for the Datadog v2 series submitter (ISS-4450).
//
// The guards here are the reason this file exists. `submitSeries` attaches
// DD-API-KEY to a URL built from DD_SITE, so its allowlist, its refusal to
// follow redirects, and its refusal to echo a raw error message are security
// controls — and a control that no test executes is one that a later refactor
// removes silently. The only production consumer mocks `submitSeries` wholesale,
// so without this suite none of that code runs under test at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatadogSeries } from "../telemetry/series";
import { importModuleWithFetch } from "./test-helpers";

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../log", () => ({ log: logMock }));

const LOG_TAG = "[series-test]";
const API_KEY = "dd-api-key-value";

const SERIES: DatadogSeries[] = [
  {
    metric: "symphony.test.gauge",
    type: 3,
    points: [{ timestamp: 1_785_950_000, value: 42 }],
    tags: ["base:main"],
  },
];

function okResponse() {
  return { ok: true, status: 202 } as Response;
}

function statusResponse(status: number) {
  return { ok: false, status } as Response;
}

/** Imports the module fresh with `fetch` stubbed, so keys() reads stubbed env. */
async function submitWith(fetchMock: ReturnType<typeof vi.fn>) {
  const mod = await importModuleWithFetch(
    fetchMock,
    () => import("../telemetry/series")
  );
  return mod.submitSeries(SERIES, LOG_TAG);
}

beforeEach(() => {
  vi.stubEnv("DD_API_KEY", API_KEY);
  vi.stubEnv("DD_SITE", "datadoghq.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("submitSeries", () => {
  it("posts to the site-derived series endpoint and reports ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());

    const status = await submitWith(fetchMock);

    expect(status).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.datadoghq.com/api/v2/series");
    expect(init.method).toBe("POST");
    expect(init.headers["DD-API-KEY"]).toBe(API_KEY);
    expect(JSON.parse(init.body)).toEqual({ series: SERIES });
  });

  it("refuses to follow redirects, so a 307 cannot replay the key elsewhere", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());

    await submitWith(fetchMock);

    // Without this, a redirect replays both the body and DD-API-KEY to a host
    // the allowlist never approved.
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
  });

  it("sends nothing when DD_API_KEY is unset", async () => {
    vi.stubEnv("DD_API_KEY", "");
    const fetchMock = vi.fn();

    const status = await submitWith(fetchMock);

    expect(status).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["datadoghq.com@attacker.example", "userinfo authority"],
    ["evil.example", "unknown host"],
    ["DATADOGHQ.COM", "case variant"],
    ["datadoghq.com.", "trailing dot"],
    ["datadoghq.com:8443", "port suffix"],
    ["datadoghq.com.attacker.example", "suffix extension"],
  ])("sends nothing when DD_SITE is %s (%s) — no key egress", async (site) => {
    // The userinfo case is the live one: `https://api.datadoghq.com@attacker
    // .example/...` resolves its authority to attacker.example, so a
    // substring or prefix check would hand DD-API-KEY straight to it.
    vi.stubEnv("DD_SITE", site);
    const fetchMock = vi.fn();

    const status = await submitWith(fetchMock);

    expect(status).toBe("disallowed_site");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a disallowed site WITHOUT queueing it to the log sink", async () => {
    // The sink builds https://http-intake.logs.${DD_SITE}/... from this same
    // unchecked value with this same key attached, so reporting the rejection
    // through `log.*` would hand DD-API-KEY to the host just refused. The
    // workflow this replaced wrote only to its local job log for this reason.
    vi.stubEnv("DD_SITE", "datadoghq.com@attacker.example");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // silence
    });
    const fetchMock = vi.fn();

    await submitWith(fetchMock);

    expect(logMock.error).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
    // Still reported — locally, where it cannot egress.
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("honors a caller-supplied retry bound", async () => {
    // The route's fallback beat runs under what is left of a platform deadline,
    // so it must be able to buy a single attempt rather than the default three.
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(500));
    const mod = await importModuleWithFetch(
      fetchMock,
      () => import("../telemetry/series")
    );

    const status = await mod.submitSeries(SERIES, LOG_TAG, { maxRetries: 0 });

    expect(status).toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a worst-case budget a caller can reserve against", async () => {
    const mod = await importModuleWithFetch(
      vi.fn(),
      () => import("../telemetry/series")
    );

    // 3 attempts x 10s + (200ms + 400ms) backoff.
    expect(mod.seriesWorstCaseMs()).toBe(30_600);
    // The no-retry form the fallback beat uses: one attempt, no backoff.
    expect(mod.seriesWorstCaseMs(0)).toBe(10_000);
  });

  it("rejects without retrying on a terminal 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(403));

    const status = await submitWith(fetchMock);

    expect(status).toBe("rejected");
    // A bad key or malformed payload will not fix itself; retrying only burns
    // the cron's time budget.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx and reports ok when a later attempt lands", async () => {
    // The workflow this replaced used `curl --retry 2`. Dropping it would turn
    // one transient blip into a lost sample and a false "poller down" alert.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(503))
      .mockResolvedValueOnce(okResponse());

    const status = await submitWith(fetchMock);

    expect(status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 rather than treating rate limiting as terminal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(okResponse());

    expect(await submitWith(fetchMock)).toBe("ok");
  });

  it("gives up after a bounded number of attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(500));

    const status = await submitWith(fetchMock);

    expect(status).toBe("rejected");
    // Bounded: one initial attempt plus SERIES_MAX_RETRIES. An unbounded loop
    // would hang the cron past its own deadline.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a transport error and never rejects the caller", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(okResponse());

    expect(await submitWith(fetchMock)).toBe("ok");
  });

  it("returns rejected rather than throwing when every attempt errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"));

    // Telemetry failure must never take down its caller.
    expect(await submitWith(fetchMock)).toBe("rejected");
  });

  it("never writes the raw error message, which can carry DD-API-KEY", async () => {
    // Undici raises `TypeError: Invalid header value: <value>` for a header the
    // runtime rejects — and for this request that value IS the API key. Logging
    // `error.message` would therefore publish the key to the log sink. The
    // same guard exists in packages/database/scripts/migrate-telemetry.ts.
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new TypeError(`Invalid header value: ${API_KEY}\nfor DD-API-KEY`)
      );

    await submitWith(fetchMock);

    const logged = JSON.stringify(logMock.warn.mock.calls);
    expect(logged).not.toContain(API_KEY);
    // The classification still has to survive, or the guard would have been
    // bought by making the failure undiagnosable.
    expect(logged).toContain("TypeError");
  });
});
