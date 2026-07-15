import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  emitDecisionTableVerificationTelemetry,
  redactWorkdirPaths,
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

test("scanDecisionTableVerificationTelemetry strips the absolute workdir from reported records", async () => {
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "dt-telemetry-reported-")
  );
  tempPathsToClean.push(workDir);
  await fs.writeFile(
    path.join(workDir, "decision-table-verifications.jsonl"),
    `${verificationLine({
      // A home-rooted absolute workdir is exactly the value FEA-2702 must not
      // egress; the JSONL records the same workdir the scan is reading.
      workdir: workDir,
      decision_table_path: ".closedloop-ai/decision-tables/pln-302.md",
    })}\n`
  );

  const result = scanDecisionTableVerificationTelemetry(workDir);

  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.telemetryStatus, "reported");
  // The emitted path is relative — no absolute workdir / OS username.
  assert.equal(record.telemetryFilePath, "decision-table-verifications.jsonl");
  assert.equal(record.workdir, "<workdir>");
  assert.ok(!record.workdir.includes(workDir));
  // Already-relative decision-table paths are preserved.
  assert.equal(
    record.decisionTablePath,
    ".closedloop-ai/decision-tables/pln-302.md"
  );
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

test("scanDecisionTableVerificationTelemetry relativizes the emitted telemetry path away from the absolute workdir", () => {
  // Simulate a home-rooted workdir that would leak the OS username if emitted.
  const workDir = path.join(os.tmpdir(), "alice-home", "Code", "proj", "work");

  const result = scanDecisionTableVerificationTelemetry(workDir);

  assert.equal(result.missing?.missingReason, "file_not_found");
  // Egress carries only the relative path, never the absolute workdir.
  assert.equal(
    result.missing?.telemetryFilePath,
    "decision-table-verifications.jsonl"
  );
  assert.ok(!result.missing?.telemetryFilePath?.includes(workDir));
  // The top-level filePath stays absolute for local operator logging.
  assert.ok(path.isAbsolute(result.filePath));
  assert.equal(
    result.filePath,
    path.join(workDir, "decision-table-verifications.jsonl")
  );
});

test("scanDecisionTableVerificationTelemetry scrubs the workdir from read-error diagnostics", async () => {
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "dt-telemetry-read-error-")
  );
  tempPathsToClean.push(workDir);
  // A directory where the JSONL file is expected makes readFileSync throw,
  // exercising the read_error branch.
  await fs.mkdir(path.join(workDir, "decision-table-verifications.jsonl"));

  const result = scanDecisionTableVerificationTelemetry(workDir);

  assert.equal(result.missing?.missingReason, "read_error");
  assert.equal(
    result.missing?.telemetryFilePath,
    "decision-table-verifications.jsonl"
  );
  assert.ok(result.missing?.readError !== undefined);
  assert.ok(!result.missing?.readError?.includes(workDir));
});

test("redactWorkdirPaths removes the absolute path (and OS username) from error text", () => {
  const workDir = "/Users/alice/Code/proj/.closedloop-ai/work";
  const filePath = path.join(workDir, "decision-table-verifications.jsonl");
  const relativeFilePath = "decision-table-verifications.jsonl";
  const readError = `EACCES: permission denied, open '${filePath}'`;

  const scrubbed = redactWorkdirPaths(
    readError,
    workDir,
    filePath,
    relativeFilePath
  );

  assert.ok(!scrubbed.includes(workDir));
  assert.ok(!scrubbed.includes("alice"));
  assert.equal(
    scrubbed,
    "EACCES: permission denied, open 'decision-table-verifications.jsonl'"
  );
});

test("redactWorkdirPaths leaves text untouched when the workdir is empty", () => {
  const text = "ENOENT: no such file or directory";

  // An empty search string must not be passed to replaceAll (it would insert
  // the replacement between every character).
  const scrubbed = redactWorkdirPaths(text, "", "", "");

  assert.equal(scrubbed, text);
});

test("redactWorkdirPaths masks a home-rooted absolute path outside the workdir", () => {
  // decision_table_path can point outside closedLoopWorkDir (e.g. a plan file
  // elsewhere under $HOME). Stripping only the workdir prefix would leave that
  // username-bearing absolute path intact, so the home-directory prefix must be
  // collapsed to `~` as well.
  const home = os.homedir();
  const workDir = path.join(home, "Code", "proj", ".closedloop-ai", "work");
  const filePath = path.join(workDir, "decision-table-verifications.jsonl");
  const outsidePath = path.join(home, "other-project", "decision-table.md");

  const scrubbed = redactWorkdirPaths(
    outsidePath,
    workDir,
    filePath,
    "decision-table-verifications.jsonl"
  );

  assert.ok(!scrubbed.includes(home));
  assert.equal(scrubbed, path.join("~", "other-project", "decision-table.md"));
});
