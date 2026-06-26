import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  emitDecisionTableVerificationTelemetry,
  scanDecisionTableVerificationTelemetry,
} from "../src/main/decision-table-verification-telemetry.js";
import type { TelemetryEventPayload } from "../src/main/telemetry-protocol.js";

const tempPathsToClean: string[] = [];

afterEach(async () => {
  for (const tempPath of tempPathsToClean.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }
});

function verificationLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-04-29T15:00:00Z",
    workdir: "/tmp/work",
    decision_table_path: ".closedloop-ai/decision-tables/pln-302.md",
    final_status: "aligned",
    iterations: 3,
    drift_kind_counts: {
      code_drift: 2,
      test_drift: 1,
      plan_ambiguity: 0,
    },
    fixes_attempted: 3,
    parse_failures: 0,
    verifier_invocations: 3,
    phase_duration_ms: 58_921,
    ...overrides,
  });
}

test("scanDecisionTableVerificationTelemetry reads only JSONL records appended after start offset", async () => {
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "dt-telemetry-scan-")
  );
  tempPathsToClean.push(workDir);

  const priorContent = [
    verificationLine({
      timestamp: "2026-04-29T15:00:00Z",
      final_status: "verification_failed",
      fixes_attempted: 99,
    }),
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(workDir, "decision-table-verifications.jsonl"),
    [
      priorContent,
      verificationLine({
        timestamp: "2026-04-29T15:00:00Z",
        final_status: "aligned_with_clarifications",
        fixes_attempted: 4,
      }),
    ].join("\n")
  );

  const result = scanDecisionTableVerificationTelemetry(workDir, {
    startOffset: Buffer.byteLength(priorContent),
  });

  assert.equal(result.records.length, 1);
  assert.equal(
    result.filePath,
    path.join(workDir, "decision-table-verifications.jsonl")
  );
  assert.equal(result.records[0].finalStatus, "aligned_with_clarifications");
  assert.equal(result.records[0].fixesAttempted, 4);
  assert.equal(result.records[0].lineNumber, 3);
  assert.equal(result.linesRead, 1);
  assert.equal(result.invalidLines, 0);
});

test("emitDecisionTableVerificationTelemetry reports missing files as skip telemetry", () => {
  const telemetryEvents: TelemetryEventPayload[] = [];

  const summary = emitDecisionTableVerificationTelemetry({
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    loopId: "loop-1",
    closedLoopWorkDir: path.join(os.tmpdir(), "missing-dt-telemetry"),
    startOffset: 123,
  });

  assert.equal(summary.emittedRecords, 0);
  assert.equal(summary.emittedMissing, true);
  assert.equal(summary.missingReason, "file_not_found");
  assert.equal(telemetryEvents.length, 1);
  assert.equal(telemetryEvents[0].category, "job.decision_table_verification");
  assert.equal(
    telemetryEvents[0].diagnostics?.decisionTableVerification?.telemetryStatus,
    "missing"
  );
});
