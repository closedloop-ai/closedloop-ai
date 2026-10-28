/**
 * @file agent-dashboard-bootstrap-fixture.ts
 * @description The shared fixtures for driving the REAL
 * `bootstrapAgentDashboardRuntime` in a unit lane.
 *
 * Extracted by ISS-9197, which gave the boot path a second suite: ISS-8907 owns
 * the telemetry DIMENSION a failure carries, and this ticket owns WHICH failures
 * terminate. Both need the same inert deps bag and the same store-open-timeout
 * error, and two copies of either is how the two suites would come to disagree
 * about what the boot path is handed.
 */

import { vi } from "vitest";
import type { AgentDashboardRuntimeBootstrapDeps } from "../src/main/dashboard/agent-dashboard-runtime-bootstrap.js";
import {
  DB_HOST_EXITED_SIGNATURE,
  STORE_OPEN_TIMEOUT_SIGNATURE,
} from "../src/shared/transient-db-host-error.js";

/** The members a case actually observes; everything else is inert. */
type BootstrapDepsOverrides = {
  emitAppExceptionEvent?: ReturnType<typeof vi.fn>;
  configureOrgDirectoryPersistence?: () => Promise<void>;
  sleepBeforeStoreOpenRetry?: (ms: number) => Promise<void>;
  setAgentMonitorRuntimeStatus?: (status: unknown) => void;
  setAgentMonitorFailed?: (reason: string) => void;
  registerDisabledAgentDashboardDbIpcHandlers?: () => void;
  isShuttingDown?: () => boolean;
  refreshTrayState?: () => void;
};

/**
 * The store-open TIMEOUT exactly as the boot path receives it.
 *
 * Composed from the two production signature constants rather than written out,
 * so a rename on either side reaches this fixture instead of leaving it green
 * against a string nothing mints any more. That the REAL producer emits this
 * shape — the lifecycle prefix `storeDeathError` adds, then the deadline token —
 * is pinned separately in `db-host-store-close-and-deadline.test.ts`, driven
 * through `createDbStoreClient` on a hand-rolled clock; this fixture is the
 * far end of that same hop, after the utilityProcess boundary has rebuilt it as
 * a plain `Error`.
 *
 * The default is the deadline the ISS-9197 install actually reported.
 */
export function storeOpenTimeoutError(deadlineMs = 600_000): Error {
  return new Error(
    `${DB_HOST_EXITED_SIGNATURE}: ${STORE_OPEN_TIMEOUT_SIGNATURE} ${deadlineMs}ms`
  );
}

/**
 * A bootstrap deps bag whose members are all inert unless a case overrides one.
 *
 * `buildRuntimeOptions` wraps every accessor in a closure it never invokes on
 * the failure path, so the un-overridden members are present because the type
 * requires them and for no other reason.
 */
export function bootstrapDeps(
  overrides: BootstrapDepsOverrides = {}
): AgentDashboardRuntimeBootstrapDeps {
  const noop = vi.fn();
  return {
    goldenMode: null,
    desktopWindow: { getWindow: noop, isTrustedSender: noop },
    rendererGates: {
      whenInitialDashboardDataServed: noop,
      whenInitialDashboardBackgroundWorkAllowed: noop,
      waitForRendererBackgroundSlot: noop,
      hasRecentRendererRead: noop,
      notifyRendererDbRead: noop,
      notifyInitialDashboardDataServed: noop,
      notifyInitialCollectorImportComplete: noop,
    },
    settingsStore: {
      getDataSyncLevel: noop,
      getCollectorEnabledState: noop,
      getClaudeCodeOtelCaptureEnabled: noop,
    },
    appOtelRuntime: {
      emitAppExceptionEvent: overrides.emitAppExceptionEvent ?? noop,
      emitIpcPerfEvent: noop,
      emitImportHealthEvent: noop,
      emitSyncBatchEvent: noop,
    },
    agentSessionSync: {
      injectBackfillIds: noop,
      notifyLocalSessionActivity: noop,
    },
    requiredPluginInstaller: { notifyRuntimeReady: noop },
    getAuditService: noop,
    getTranscriptSync: () => null,
    getApiKey: () => null,
    getAccessToken: () => Promise.resolve(null),
    getSessionIdentity: () => null,
    invalidateAccessToken: noop,
    getApiOrigin: () => "https://example.invalid",
    getProfileId: () => "test",
    getCloudReadComputeTargetId: () => null,
    getSyncComputeTargetId: () => null,
    getUserIdentity: () => null,
    subscribeUserIdentityChanged: () => noop,
    notifySessionTerminal: noop,
    onTerminalFailure: noop,
    refreshTrayState: overrides.refreshTrayState ?? noop,
    setAgentMonitorRuntimeStatus:
      overrides.setAgentMonitorRuntimeStatus ?? noop,
    setAgentMonitorFailed: overrides.setAgentMonitorFailed ?? noop,
    registerDisabledAgentDashboardDbIpcHandlers:
      overrides.registerDisabledAgentDashboardDbIpcHandlers ?? noop,
    clearDisabledAgentDashboardDbIpcRegistered: noop,
    configureOrgDirectoryPersistence:
      overrides.configureOrgDirectoryPersistence ?? (() => Promise.resolve()),
    isShuttingDown: overrides.isShuttingDown ?? (() => false),
    ...(overrides.sleepBeforeStoreOpenRetry
      ? { sleepBeforeStoreOpenRetry: overrides.sleepBeforeStoreOpenRetry }
      : {}),
  } as unknown as AgentDashboardRuntimeBootstrapDeps;
}
