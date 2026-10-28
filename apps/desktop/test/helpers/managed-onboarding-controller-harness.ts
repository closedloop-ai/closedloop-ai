/**
 * @file managed-onboarding-controller-harness.ts
 * @description Shared `ManagedOnboardingController` harness for the controller
 * suites. `SettingsStore` is real (temp-dir cwd) so settings writes and the
 * setup-readiness projection run against production logic; every other
 * injected collaborator is a `vi.fn()` fake, cast through the whole-bag
 * `as unknown as ManagedOnboardingControllerDeps` pattern these desktop tests use.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, vi } from "vitest";
import {
  ManagedOnboardingController,
  type ManagedOnboardingControllerDeps,
} from "../../src/main/onboarding/managed-onboarding-controller.js";
import type { PendingOnboardingHandoff } from "../../src/main/onboarding/onboarding-handoff.js";
import { SettingsStore } from "../../src/main/settings/settings-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type SigningKeyResult =
  | { ok: false; reason: string }
  | { ok: true; keyPair: unknown };

export type ControllerOptions = {
  shuttingDown?: boolean;
  setupComplete?: boolean;
  hasApiKey?: boolean;
  apiKeyProvenance?: "USER_CREATED" | "DESKTOP_MANAGED" | null;
  accessToken?: string | null;
  getOrCreateResult?: SigningKeyResult;
  loadResult?: SigningKeyResult;
  deviceDescriptor?: Record<string, unknown>;
  credentialMutationAllowed?: boolean;
};

export function makeController(options: ControllerOptions = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-onboarding-"));
  tempDirs.push(tmpDir);
  const settingsStore = new SettingsStore({
    cwd: tmpDir,
    name: "test-settings",
  });

  const apiKeyStore = {
    getApiKey: vi.fn(() => (options.hasApiKey ? "sk_live_x" : null)),
    getApiKeyProvenance: vi.fn(() => options.apiKeyProvenance ?? null),
    getStatus: vi.fn(() => ({ hasApiKey: options.hasApiKey ?? false })),
    setApiKey: vi.fn((_apiKey: string, _provenance: string) => undefined),
    saveProfileKey: vi.fn(
      (_configId: string, _apiKey: string, _provenance: string) => undefined
    ),
  };
  const desktopSessionManager = {
    getAccessToken: vi.fn(
      (): Promise<string | null> => Promise.resolve(options.accessToken ?? null)
    ),
    refreshExistingUserResolution: vi.fn(),
  };
  const gatewaySigningKeyStore = {
    getOrCreate: vi.fn(
      () => options.getOrCreateResult ?? { ok: false, reason: "no-key" }
    ),
    load: vi.fn(() => options.loadResult ?? { ok: false, reason: "no-key" }),
  };
  const telemetryOrgProvider = { warm: vi.fn() };
  const desktopWindow = {
    sendToRenderer: vi.fn((..._args: unknown[]) => undefined),
  };

  const deps = {
    settingsStore,
    apiKeyStore,
    desktopSessionManager,
    gatewaySigningKeyStore,
    telemetryOrgProvider,
    desktopWindow,
    isCredentialMutationAllowed: vi.fn(
      () => options.credentialMutationAllowed ?? true
    ),
    isShuttingDown: vi.fn(() => options.shuttingDown ?? false),
    showWindow: vi.fn(),
    getActiveGatewayId: vi.fn(() => "gateway-1"),
    resolveDesktopDeviceDescriptor: vi.fn(() => options.deviceDescriptor ?? {}),
    reportDesktopPopUnavailable: vi.fn(
      (_surface: string, _reason: string) => undefined
    ),
    signDesktopRequest: vi.fn((_request: unknown): unknown => null),
    persistActiveProfileKey: vi.fn(),
    persistActiveConfigManagedMetadata: vi.fn(),
    reportBootstrapClaimDiagnostic: vi.fn(),
    restartCloudSocket: vi.fn(),
    isDesktopSetupComplete: vi.fn(() => options.setupComplete ?? false),
    registerOpenFileHandler: vi.fn(
      (_onOpenFile: (filePath: string) => void) => undefined
    ),
    showMessageBox: vi.fn(
      (_options: unknown): Promise<{ response: number }> =>
        Promise.resolve({ response: 0 })
    ),
    openExternalUrl: vi.fn((_url: string): Promise<void> => Promise.resolve()),
  };
  const controller = new ManagedOnboardingController(
    deps as unknown as ManagedOnboardingControllerDeps
  );
  return { controller, ...deps };
}

export type ControllerHarness = ReturnType<typeof makeController>;

/** The single-retry wrapper's options, exactly as the controller passes them. */
export type RetryOptions = {
  operation: () => Promise<unknown>;
  shouldRetry: (result: unknown) => boolean;
  delayMs: number;
  isCancelled?: () => boolean;
};

export const WEB_APP_ORIGIN = "https://app.closedloop.ai";
export const RETRY_THEN_MANUAL = [
  "retry_automated_onboarding",
  "use_manual_setup",
];
export const MANUAL_THEN_RETRY = [
  "use_manual_setup",
  "retry_automated_onboarding",
];
export const MANUAL_ONLY = ["use_manual_setup"];

export function handoff(
  overrides: Partial<PendingOnboardingHandoff> = {}
): PendingOnboardingHandoff {
  return {
    onboardingAttemptId: "attempt-1",
    webAppOrigin: WEB_APP_ORIGIN,
    createdAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

export function failedState(message: string, recoveryActions: string[]) {
  return { status: "failed", message, recoveryActions };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
