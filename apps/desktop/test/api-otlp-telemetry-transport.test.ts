import assert from "node:assert/strict";
import { DesktopClientAttributionHeader } from "@repo/api/src/types/desktop-client-attribution";
import {
  KEYLESS_TELEMETRY_API_ROUTE_PREFIX,
  KEYLESS_TELEMETRY_CONTENT_TYPE,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
  KeylessTelemetrySignal,
} from "@repo/shared-platform/keyless-telemetry";
import { afterEach, describe, it, vi } from "vitest";
import { createApiOtlpTelemetryTransport } from "../src/main/telemetry/api-otlp-telemetry-transport.js";
import type {
  RelayTelemetrySignal,
  RelayTelemetryTransportDiagnostics,
  RelayTelemetryTransportHandle,
  TelemetrySessionContext,
} from "../src/main/telemetry/relay-telemetry-transport.js";

const API_ORIGIN = "https://api.example.test";
const CONTEXT: TelemetrySessionContext = {
  appInstallationId: "2f1c8f8e-3b7a-4c1d-9e2f-5a6b7c8d9e0f",
  serviceVersion: "1.2.3",
  deploymentEnvironmentName: "production",
};
const BODY = new Uint8Array([1, 2, 3]);

describe("api OTLP telemetry transport (ISS-12211)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the body unchanged to the API route with the install id and no credential", async () => {
    const harness = createHarness([200]);
    harness.transport.start(CONTEXT);

    assert.equal(
      await harness.transport.export(KeylessTelemetrySignal.Traces, BODY),
      true
    );

    assert.equal(harness.requests.length, 1);
    const [request] = harness.requests;
    assert.equal(
      request.url,
      `${API_ORIGIN}${KEYLESS_TELEMETRY_API_ROUTE_PREFIX}/v1/traces`
    );
    assert.equal(request.init.method, "POST");
    assert.deepEqual(request.init.headers, {
      [DesktopClientAttributionHeader.InstallationId]:
        CONTEXT.appInstallationId,
      [DesktopClientAttributionHeader.ClientVersion]: CONTEXT.serviceVersion,
      "content-type": KEYLESS_TELEMETRY_CONTENT_TYPE,
    });
    assert.deepEqual(request.init.body, BODY);
    assert.equal(harness.transport.getDiagnostics().sent, 1);
    assert.equal(harness.fallback.started.length, 0);
  });

  it("switches to the relay lane on a 404 and stays there for the process", async () => {
    const harness = createHarness([200, 404]);
    harness.transport.start(CONTEXT);

    assert.equal(
      await harness.transport.export(KeylessTelemetrySignal.Logs, BODY),
      true
    );
    assert.equal(
      await harness.transport.export(KeylessTelemetrySignal.Metrics, BODY),
      true
    );
    assert.equal(
      await harness.transport.export(KeylessTelemetrySignal.Traces, BODY),
      false
    );

    assert.equal(
      harness.requests.length,
      2,
      "nothing after the 404 hits the route"
    );
    assert.deepEqual(harness.fallback.started, [CONTEXT]);
    assert.deepEqual(harness.fallback.exports, [
      KeylessTelemetrySignal.Metrics,
      KeylessTelemetrySignal.Traces,
    ]);
    const diagnostics = harness.transport.getDiagnostics();
    assert.equal(
      diagnostics.sent,
      2,
      "one through the route, one through the relay"
    );
    assert.equal(diagnostics.droppedCollectorUnavailable, 1);
    assert.equal(diagnostics.connected, true);
  });

  it.each([
    [429, "droppedRateLimited"],
    [503, "droppedCollectorUnavailable"],
  ] as const)(
    "counts a %i as %s and cools down for the Retry-After it names",
    async (status, counter) => {
      let now = 0;
      const harness = createHarness([status, 200], {
        now: () => now,
        retryAfter: "60",
      });
      harness.transport.start(CONTEXT);

      await harness.transport.export(KeylessTelemetrySignal.Logs, BODY);
      now = 59_999;
      await harness.transport.export(KeylessTelemetrySignal.Logs, BODY);
      now = 60_000;
      await harness.transport.export(KeylessTelemetrySignal.Logs, BODY);

      const diagnostics = harness.transport.getDiagnostics();
      assert.equal(
        harness.requests.length,
        2,
        "the cooled-down export never left"
      );
      assert.equal(diagnostics[counter], status === 429 ? 2 : 1);
      assert.equal(diagnostics.sent, 1);
    }
  );

  it("cools down for the default window when the request goes unanswered", async () => {
    let now = 0;
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(
      AbortSignal.abort(new DOMException("timed out", "TimeoutError"))
    );
    const harness = createHarness(["timeout"], { now: () => now });
    harness.transport.start(CONTEXT);

    await harness.transport.export(KeylessTelemetrySignal.Traces, BODY);
    now = KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS * 1000 - 1;
    await harness.transport.export(KeylessTelemetrySignal.Traces, BODY);

    const diagnostics = harness.transport.getDiagnostics();
    assert.equal(diagnostics.droppedCollectorUnavailable, 1);
    assert.equal(diagnostics.droppedRateLimited, 1);
    assert.equal(diagnostics.droppedNoSession, 0);
    assert.equal(harness.requests.length, 1);
  });

  it("counts an unreachable API as no session, with no cooldown", async () => {
    const harness = createHarness(["network", 200]);
    harness.transport.start(CONTEXT);

    await harness.transport.export(KeylessTelemetrySignal.Traces, BODY);
    await harness.transport.export(KeylessTelemetrySignal.Traces, BODY);

    const diagnostics = harness.transport.getDiagnostics();
    assert.equal(diagnostics.droppedNoSession, 1);
    assert.equal(diagnostics.droppedCollectorUnavailable, 0);
    assert.equal(diagnostics.droppedRateLimited, 0);
    assert.equal(diagnostics.sent, 1);
    assert.equal(harness.requests.length, 2);
  });

  it("keeps the later cooldown when in-flight exports answer out of order", async () => {
    let now = 0;
    const answers: ((response: Response) => void)[] = [];
    const transport = createApiOtlpTelemetryTransport({
      getApiOrigin: () => API_ORIGIN,
      fallback: createFallback(),
      fetchFn: (() =>
        new Promise<Response>((resolve) => {
          answers.push(resolve);
        })) as typeof fetch,
      now: () => now,
      shutdownDrainMs: 0,
    });
    transport.start(CONTEXT);

    const older = transport.export(KeylessTelemetrySignal.Traces, BODY);
    const newer = transport.export(KeylessTelemetrySignal.Logs, BODY);
    assert.equal(answers.length, 2);
    answers[1](
      new Response(null, { status: 429, headers: { "retry-after": "60" } })
    );
    await newer;
    answers[0](
      new Response(null, { status: 503, headers: { "retry-after": "30" } })
    );
    await older;

    now = 59_999;
    const cooled = transport.export(KeylessTelemetrySignal.Traces, BODY);
    assert.equal(answers.length, 2, "the 429's 60 s window still holds");
    assert.equal(await cooled, false);
    now = 60_000;
    const resumed = transport.export(KeylessTelemetrySignal.Traces, BODY);
    assert.equal(answers.length, 3);
    answers[2](new Response(null, { status: 200 }));
    assert.equal(await resumed, true);
  });

  it.each([400, 403, 413])(
    "counts a %i as invalid, with no cooldown",
    async (status) => {
      const harness = createHarness([status, 200]);
      harness.transport.start(CONTEXT);

      await harness.transport.export(KeylessTelemetrySignal.Traces, BODY);
      await harness.transport.export(KeylessTelemetrySignal.Traces, BODY);

      const diagnostics = harness.transport.getDiagnostics();
      assert.equal(diagnostics.droppedInvalid, 1);
      assert.equal(diagnostics.sent, 1);
      assert.equal(harness.fallback.started.length, 0);
    }
  );

  it("drops a body over the ceiling without sending it", async () => {
    const harness = createHarness([200]);
    harness.transport.start(CONTEXT);

    assert.equal(
      await harness.transport.export(
        KeylessTelemetrySignal.Traces,
        new Uint8Array(KEYLESS_TELEMETRY_MAX_BODY_BYTES + 1)
      ),
      false
    );

    assert.equal(harness.transport.getDiagnostics().droppedOversize, 1);
    assert.equal(harness.requests.length, 0);
  });

  it("sends nothing before start or after stop, and stops the relay lane it started", async () => {
    const harness = createHarness([404]);

    assert.equal(
      await harness.transport.export(KeylessTelemetrySignal.Traces, BODY),
      false
    );
    harness.transport.start(CONTEXT);
    await harness.transport.export(KeylessTelemetrySignal.Traces, BODY);
    await harness.transport.stop();

    assert.equal(
      await harness.transport.export(KeylessTelemetrySignal.Traces, BODY),
      false
    );
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.fallback.stopped, 1);
  });
});

type ScriptedResponse = number | "network" | "timeout";

function createHarness(
  script: ScriptedResponse[],
  options: { now?: () => number; retryAfter?: string } = {}
) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchFn = (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const next = script.shift() ?? 200;
    if (next === "network") {
      return Promise.reject(new TypeError("fetch failed"));
    }
    if (next === "timeout") {
      return Promise.reject(init?.signal?.reason);
    }
    return Promise.resolve(
      new Response(null, {
        status: next,
        headers: options.retryAfter
          ? { "retry-after": options.retryAfter }
          : {},
      })
    );
  };
  const fallback = createFallback();
  const transport = createApiOtlpTelemetryTransport({
    getApiOrigin: () => API_ORIGIN,
    fallback,
    fetchFn: fetchFn as typeof fetch,
    now: options.now,
    shutdownDrainMs: 0,
  });
  return { transport, requests, fallback };
}

/**
 * Accepts the first relayed export and drops the rest as collector
 * unavailable, so the summed diagnostics can tell its counters from the
 * route's.
 */
function createFallback(): RelayTelemetryTransportHandle & {
  started: TelemetrySessionContext[];
  exports: RelayTelemetrySignal[];
  stopped: number;
} {
  const diagnostics: RelayTelemetryTransportDiagnostics = {
    connected: true,
    hasSession: true,
    inCooldown: false,
    warmUpQueueDepth: 0,
    sent: 0,
    droppedOversize: 0,
    droppedNoSession: 0,
    droppedRateLimited: 0,
    droppedCollectorUnavailable: 0,
    droppedInvalid: 0,
  };
  const fallback = {
    started: [] as TelemetrySessionContext[],
    exports: [] as RelayTelemetrySignal[],
    stopped: 0,
    start: (context: TelemetrySessionContext) => {
      fallback.started.push(context);
    },
    stop: () => {
      fallback.stopped += 1;
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    export: (signal: RelayTelemetrySignal) => {
      fallback.exports.push(signal);
      if (diagnostics.sent === 0) {
        diagnostics.sent += 1;
        return Promise.resolve(true);
      }
      diagnostics.droppedCollectorUnavailable += 1;
      return Promise.resolve(false);
    },
    getDiagnostics: () => ({ ...diagnostics }),
  };
  return fallback;
}
