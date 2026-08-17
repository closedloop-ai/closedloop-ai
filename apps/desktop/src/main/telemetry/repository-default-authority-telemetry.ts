/**
 * Emit the bounded Desktop telemetry signal for a repository-default authority
 * write failure. Error text and repository/account identity are intentionally
 * excluded; this module deduplicates the signal without disturbing the periodic
 * store-integrity probe's health cadence.
 */
import { Observability } from "./observability.js";

let writeFailureReported = false;

export function reportRepositoryDefaultAuthorityWriteFailure(): void {
  if (writeFailureReported) {
    return;
  }
  writeFailureReported = true;
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: "store.integrity.failure_detected",
    message: "Repository default authority persistence failed",
    trace: {},
    diagnostics: {
      storeIntegrity: {
        healthy: false,
        durationMs: 0,
        checksRun: ["repository_default_authority"],
        issueCount: 1,
        issues: [
          {
            check: "repository_default_authority",
            category: "repository_default_authority_write_failure",
            object: "repository_default_authorities",
            objectType: "table",
          },
        ],
        truncated: false,
      },
    },
  });
}
