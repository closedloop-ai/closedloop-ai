/**
 * Decision-table verification fixtures, shared by the telemetry schema, payload
 * and sanitizer suites. Extracted from `telemetry-schema.test.ts` (ISS-7429)
 * when the diagnostics suite moved beside the sub-schemas it exercises — three
 * suites read them, so a copy per suite would be three specs to keep agreeing.
 */

export const reportedDecisionTableVerification = {
  telemetryStatus: "reported",
  telemetryFilePath:
    "/tmp/work/.closedloop-ai/decision-table-verifications.jsonl",
  lineNumber: 3,
  timestamp: "2026-05-01T13:20:06.234Z",
  workdir: "/tmp/work",
  decisionTablePath: ".closedloop-ai/decision-tables/pln-302.md",
  finalStatus: "aligned",
  iterations: 3,
  driftKindCounts: {
    codeDrift: 2,
    testDrift: 1,
    planAmbiguity: 0,
  },
  fixesAttempted: 3,
  parseFailures: 0,
  verifierInvocations: 3,
  phaseDurationMs: 58_921,
};

export const missingDecisionTableVerification = {
  telemetryStatus: "missing",
  telemetryFilePath:
    "/tmp/work/.closedloop-ai/decision-table-verifications.jsonl",
  filePresent: true,
  linesRead: 0,
  invalidLines: 0,
  missingReason: "no_current_run_records",
  readError: "permission denied",
};
