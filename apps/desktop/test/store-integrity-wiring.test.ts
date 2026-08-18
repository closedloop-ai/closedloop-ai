/**
 * @file store-integrity-wiring.test.ts
 * @description The FEA-1999 probe's schema-aware wiring is the ONLY place the
 * optional sub-checks are registered for production, and every sub-check test
 * builds its own probe with an explicit `extraChecks` array — so before this
 * file, deleting a registration line in `store-integrity-wiring.ts` left the
 * whole suite green while the fleet silently stopped reporting that check.
 *
 * This asserts the production wiring itself: each registered check must appear
 * in `checksRun` for a reader that can serve it. Added with ISS-5102
 * (`foreign_key_check`), but it guards its two predecessors equally.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createWiredStoreIntegrityProbe } from "../src/main/database/store-integrity-wiring.js";
import type { StoreIntegrityDiagnostics } from "../src/main/telemetry/telemetry-protocol.js";

/** A reader that can serve every optional check, so a check missing from
 *  `checksRun` can only mean the wiring never registered it. */
const readerServingEveryCheck = {
  runStoreIntegrityCheck: () =>
    Promise.resolve({
      quickRows: [{ quick_check: "ok" }] as Record<string, unknown>[],
      indexRows: [] as { name: string }[],
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
  runInvocationTelemetryIntegrityCheck: () =>
    Promise.resolve({
      outOfRangeTokenRows: 0,
      outOfRangeCostRows: 0,
      nonSubagentUsageRows: 0,
    }),
  runForeignKeyIntegrityCheck: () =>
    Promise.resolve({
      violationTotal: 0,
      violationTables: [],
      orphanEventAgentRows: 0,
    }),
  runRepositoryDefaultAuthorityIntegrityCheck: () =>
    Promise.resolve({ malformedRows: 0 }),
};

describe("createWiredStoreIntegrityProbe registers every schema-aware check", () => {
  test("all four optional checks reach checksRun through the production wiring", async () => {
    const probe = createWiredStoreIntegrityProbe({
      agentDatabase: readerServingEveryCheck,
      emit: (_: StoreIntegrityDiagnostics) => {},
      getIngestProgress: () => ({ preparing: false, total: 0, processed: 0 }),
      log: () => {},
    });

    const diag = await probe.runOnce();

    // Deleting any one `extraChecks` entry in store-integrity-wiring.ts fails here.
    assert.ok(diag.checksRun.includes("token_parity"));
    assert.ok(diag.checksRun.includes("invocation_telemetry"));
    assert.ok(diag.checksRun.includes("foreign_key_check"));
    assert.ok(diag.checksRun.includes("repository_default_authority"));
  });
});
