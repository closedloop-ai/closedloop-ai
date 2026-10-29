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
import { describe, test } from "vitest";
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
      invalidLineRows: 0,
    }),
  runForeignKeyIntegrityCheck: () =>
    Promise.resolve({
      violationTotal: 0,
      violationTables: [],
      orphanEventAgentRows: 0,
    }),
  runInvocationSyncOutboxIntegrityCheck: () =>
    Promise.resolve({ unreadableCreatedAtRows: 0 }),
  readStorageExhaustionHealth: () =>
    Promise.resolve({ failures: 0, lastReason: null, active: false }),
  runSessionMetadataIntegrityCheck: () => Promise.resolve({ malformedRows: 0 }),
};

describe("createWiredStoreIntegrityProbe registers every schema-aware check", () => {
  test("every remaining optional check reaches checksRun through the production wiring", async () => {
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
    // ISS-6209: the invocation-outbox timestamp check is what routes a corrupt
    // `created_at` to the monitored store-integrity event, so losing its
    // registration would silently return that corruption to being unreported.
    assert.ok(diag.checksRun.includes("invocation_sync_outbox"));
    // ISS-6337: the disk-full tally is the ONLY signal a customer whose disk
    // filled produces, so losing its registration returns that install to being
    // remotely indistinguishable from a healthy one.
    assert.ok(diag.checksRun.includes("storage_exhaustion"));
    // ISS-8259: every reader of `sessions.metadata` degrades silently on a
    // malformed blob, so this check is the only thing that reports the condition
    // at all. Losing its registration returns it to being unreported from every
    // path at once.
    assert.ok(diag.checksRun.includes("session_metadata"));
  });
});
