import {
  TelemetryCategory,
  TelemetrySeverity,
} from "@repo/observability/telemetry/telemetry-category";
import { vi } from "vitest";
import type {
  handleTelemetryEvent,
  TelemetryHandlerContext,
} from "@/lib/desktop-telemetry-handler";

/**
 * Shared wire-payload, handler-context and fresh-module-import helpers for the
 * desktop telemetry handler suites. Extracted from
 * `desktop-telemetry-handler.test.ts` (ISS-7429) when the update/shutdown,
 * outbound-network and support-upload suites moved beside the vocabularies they
 * exercise — two suites read these, and a copy per suite would be two fixtures
 * to keep agreeing about what a valid desktop payload is.
 */

export const VALID_UUID_A = "166e7770-fd87-49aa-a09b-a91cd2c404c8";
export const VALID_UUID_B = "85c4e16f-43d1-4422-b017-e9a2b7073c15";
export const COMPUTE_TARGET_ID = "target-test-001";

export const validDesktopWirePayload = {
  schemaVersion: "1",
  category: TelemetryCategory.JobStarted,
  severity: TelemetrySeverity.Info,
  timestamp: "2024-01-01T00:00:00.000Z",
  trace: {
    commandId: "cmd-1",
    operationId: "op-1",
    computeTargetId: COMPUTE_TARGET_ID,
    gatewaySessionId: VALID_UUID_A,
    sessionId: VALID_UUID_B,
  },
};

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

export const defaultHandlerContext: TelemetryHandlerContext = {
  authenticatedTargetId: COMPUTE_TARGET_ID,
};

/**
 * Stub global fetch + reset modules + dynamically import the log buffer and
 * handler so each test gets a fresh module-scope state. Callers are
 * responsible for stubbing any env vars (DD_API_KEY, DD_SERVICE, etc.)
 * BEFORE invoking this helper, since module-load reads them once.
 */
export async function importFreshHandlerWithFetch(
  fetchMock: ReturnType<typeof vi.fn>
): Promise<{
  freshLog: typeof import("@repo/observability/log").log;
  freshHandler: typeof handleTelemetryEvent;
}> {
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { log: freshLog } = await import("@repo/observability/log");
  const { handleTelemetryEvent: freshHandler } = await import(
    "@/lib/desktop-telemetry-handler"
  );
  return { freshLog, freshHandler };
}
