/**
 * ISS-12211 AC4: the stage proof's own steps, run against in-memory transports
 * and a stubbed `pup`, so nothing here reaches stage or Datadog.
 */
import assert from "node:assert/strict";
import type * as ChildProcessModule from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import { afterEach, describe, test, vi } from "vitest";
import {
  EgressPath,
  ParityRecordKind,
  parityKey,
} from "../scripts/otlp-egress-parity-diff.js";
import {
  collect,
  EXPECTED_RECORD_KEYS,
  sendThroughPath,
} from "../scripts/otlp-egress-parity-proof.js";
import {
  APP_LIFECYCLE_EVENT_NAME,
  DESKTOP_ACTIVITY_ROOT_SPAN_NAME,
} from "../src/main/telemetry/app-otel-runtime.js";
import { DesktopAppLifecycleEvent } from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import type { RelayTelemetryTransportHandle } from "../src/main/telemetry/relay-telemetry-transport.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execFileSync: vi.fn(() => JSON.stringify({ data: [] })),
}));

const outDirs: string[] = [];

afterEach(() => {
  for (const api of [trace, context, propagation, metrics, logs]) {
    api.disable();
  }
  for (const dir of outDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sendThroughPath", () => {
  test("each path's SDK exports to its own transport when the two run one after the other", async () => {
    const probeError = new Error("probe");
    const relay = createMemoryTransport();
    const route = createMemoryTransport();

    const relayResult = await sendThroughPath(
      EgressPath.Relay,
      "https://relay.example.test",
      probeError,
      () => relay.handle
    );
    const routeResult = await sendThroughPath(
      EgressPath.Route,
      "https://api.example.test",
      probeError,
      () => route.handle
    );

    for (const [result, transport] of [
      [relayResult, relay],
      [routeResult, route],
    ] as const) {
      assert.equal(result.delivered, true, result.path);
      assert.deepEqual(result.exportCalls, transport.received, result.path);
      assert.ok(transport.received.traces > 0, result.path);
      assert.ok(transport.received.logs > 0, result.path);
    }
  });
});

describe("collect", () => {
  const sentAt = "2026-10-09T21:14:27.000Z";
  const sentAtMs = Date.parse(sentAt);

  test("after the live window, says a missing retention-sampled span is not a verdict", async () => {
    // An hour on: past the 15-minute live span window.
    const { passed, lines } = await collectWithNoHits(sentAtMs + 60 * 60_000);

    assert.equal(passed, false);
    const reason = lines.find((line) => line.startsWith("not a verdict"));
    assert.ok(reason, lines.join("\n"));
    // Only the spans retention may drop: not the always-kept ERROR span, not the log.
    const retentionSampled = [
      parityKey(ParityRecordKind.Span, DESKTOP_ACTIVITY_ROOT_SPAN_NAME),
      parityKey(
        ParityRecordKind.Span,
        APP_LIFECYCLE_EVENT_NAME,
        DesktopAppLifecycleEvent.Start
      ),
    ];
    for (const key of EXPECTED_RECORD_KEYS) {
      assert.equal(reason.includes(key), retentionSampled.includes(key), key);
    }
  });

  test("inside the live window, says to re-run instead", async () => {
    // Six minutes on: past the Collector's 315 s hold, inside the live window.
    const { passed, lines } = await collectWithNoHits(sentAtMs + 6 * 60_000);

    assert.equal(passed, false);
    assert.ok(lines.some((line) => line.startsWith("records may still be")));
    assert.ok(!lines.some((line) => line.startsWith("not a verdict")));
  });

  async function collectWithNoHits(
    nowMs: number
  ): Promise<{ passed: boolean; lines: string[] }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowMs);
    const outDir = mkdtempSync(join(tmpdir(), "otlp-egress-parity-"));
    outDirs.push(outDir);
    writeFileSync(
      join(outDir, "run.json"),
      JSON.stringify({
        sentAt,
        finishedAt: sentAt,
        paths: {
          relay: { installationId: "620a2a70-8516-43e7-a35d-b3419be83639" },
          route: { installationId: "c34b8025-853e-40c0-afeb-a6fe0694721c" },
        },
      })
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const passed = await collect(outDir);
    return { passed, lines: log.mock.calls.map((args) => String(args[0])) };
  }
});

function createMemoryTransport(): {
  handle: RelayTelemetryTransportHandle;
  received: Record<KeylessTelemetrySignal, number>;
} {
  const received: Record<KeylessTelemetrySignal, number> = {
    traces: 0,
    metrics: 0,
    logs: 0,
  };
  const sent = () => received.traces + received.metrics + received.logs;
  const handle: RelayTelemetryTransportHandle = {
    start: () => undefined,
    stop: () => undefined,
    flush: () => Promise.resolve(),
    export: (signal) => {
      received[signal] += 1;
      return Promise.resolve(true);
    },
    getDiagnostics: () => ({
      connected: true,
      hasSession: true,
      inCooldown: false,
      warmUpQueueDepth: 0,
      sent: sent(),
      droppedOversize: 0,
      droppedNoSession: 0,
      droppedRateLimited: 0,
      droppedCollectorUnavailable: 0,
      droppedInvalid: 0,
    }),
  };
  return { handle, received };
}
