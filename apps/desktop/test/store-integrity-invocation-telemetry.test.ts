/**
 * @file store-integrity-invocation-telemetry.test.ts
 * @description ISS-7980 characterization of malformed invocation-telemetry
 * aggregate replies at the regularly wired store-integrity boundary.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createStoreIntegrityProbe,
  type StoreIntegrityReader,
} from "../src/main/database/database-integrity/store-integrity-probe.js";
import {
  type InvocationTelemetryIntegrityCounts,
  type InvocationTelemetryReader,
  invocationTelemetryCheck,
} from "../src/main/database/invocation-telemetry-integrity.js";
import { closedloopExpectedIndexNames } from "../src/main/database/store-index-policy.js";
import { createWiredStoreIntegrityProbe } from "../src/main/database/store-integrity-wiring.js";

const VALID_COUNTS: InvocationTelemetryIntegrityCounts = {
  outOfRangeTokenRows: 0,
  outOfRangeCostRows: 0,
  nonSubagentUsageRows: 0,
  invalidLineRows: 0,
};
const INVOCATION_CHECK_FAILED_RE =
  /invocation telemetry integrity check failed/;

describe("ISS-7980 invocation telemetry integrity reply validation", () => {
  for (const [label, raw] of [
    ["an undefined reply", undefined],
    ["a negative count", { ...VALID_COUNTS, outOfRangeTokenRows: -1 }],
    ["a fractional count", { ...VALID_COUNTS, outOfRangeCostRows: 1.5 }],
    [
      "an unsafe count",
      {
        ...VALID_COUNTS,
        nonSubagentUsageRows: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
  ] as const) {
    test(`${label} is rejected while the engine checks remain usable`, async () => {
      const logs: string[] = [];
      const reader = readerWithInvocationReply(raw);
      const probe = createStoreIntegrityProbe(reader, {
        emit: () => {},
        expectedIndexNames: [],
        extraChecks: [invocationTelemetryCheck(reader)],
        log: (message) => logs.push(message),
      });

      const diagnostics = await probe.runOnce();

      assert.deepEqual(diagnostics.checksRun, [
        "quick_check",
        "index_presence",
      ]);
      assert.equal(
        diagnostics.issues.some(
          (issue) => issue.check === "invocation_telemetry"
        ),
        false,
        "a rejected tally must not be partially classified"
      );
      assert.equal(diagnostics.healthy, true);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? "", INVOCATION_CHECK_FAILED_RE);
    });
  }

  test("a missing optional reader is omitted while the other wired checks continue", async () => {
    const expectedIndexes = closedloopExpectedIndexNames();
    const agentDatabase = {
      runStoreIntegrityCheck: () =>
        Promise.resolve({
          quickRows: [{ quick_check: "ok" }] as Record<string, unknown>[],
          indexRows: expectedIndexes.map((name) => ({ name })),
        }),
      runTokenParityCheck: () =>
        Promise.resolve({
          usageInput: 0,
          usageOutput: 0,
          usageCacheRead: 0,
          usageCacheWrite: 0,
          eventsInput: 0,
          eventsOutput: 0,
          eventsCacheRead: 0,
          eventsCacheWrite: 0,
          divergentSessionCount: 0,
        }),
    };
    const probe = createWiredStoreIntegrityProbe({
      agentDatabase,
      emit: () => {},
      getIngestProgress: () => ({ preparing: false, total: 0, processed: 0 }),
      log: () => {},
    });

    const diagnostics = await probe.runOnce();

    assert.ok(diagnostics.checksRun.includes("quick_check"));
    assert.ok(diagnostics.checksRun.includes("index_presence"));
    assert.ok(diagnostics.checksRun.includes("token_parity"));
    assert.equal(
      diagnostics.checksRun.includes("invocation_telemetry"),
      false,
      "an older reader without the optional method is not reported as clean"
    );
    assert.equal(diagnostics.healthy, true);
  });
});

function readerWithInvocationReply(
  raw: unknown
): StoreIntegrityReader & InvocationTelemetryReader {
  return {
    runStoreIntegrityCheck: () =>
      Promise.resolve({
        quickRows: [{ quick_check: "ok" }],
        indexRows: [],
      }),
    runInvocationTelemetryIntegrityCheck: () =>
      Promise.resolve(raw as InvocationTelemetryIntegrityCounts),
  };
}
