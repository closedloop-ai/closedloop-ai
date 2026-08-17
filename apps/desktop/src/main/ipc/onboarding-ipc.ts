import { shell } from "electron";
import { CLI_BINARY_TOOLS } from "../../shared/cli-binary-tools.js";
import type { DataSyncLevel } from "../../shared/contracts.js";
import { normalizeDataSyncLevel } from "../../shared/data-sync-level.js";
import {
  SANDBOX_REQUIRED_MESSAGE,
  SANDBOX_RISKY_ROOT_MESSAGE,
} from "../../shared/sandbox-messages.js";
import {
  isRiskyAllowedDirectory,
  normalizeScopePath,
} from "../../shared/sandbox-policy.js";
import { ONBOARDING_WIZARD_PATH } from "../onboarding/onboarding-popup.js";
import type { DesktopOnboardingState } from "../onboarding/onboarding-state.js";
import type { ApiKeyStore } from "../settings/api-key-store.js";
import { isAllowedExternalUrl } from "../settings/external-url-allowlist.js";
import {
  normalizeAndValidateOrigin,
  normalizeWebAppOrigin,
} from "../settings/origin-policy.js";
import { seedReposConfig } from "../settings/seed-repos-config.js";
import type { SettingsStore } from "../settings/settings-store.js";
import { Observability } from "../telemetry/observability.js";
import type { BinaryPathPatch, CliBinaryTool } from "./binary-paths-ipc.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";
import { normalizeClosedloopApiKey } from "./profile-config-ipc.js";
import {
  applySyncConsent,
  readSyncConsentRecord,
  type SyncConsentApplyDeps,
} from "./sync-consent-apply.js";
import { applySyncObservabilityTier } from "./sync-observability-tier-apply.js";

export const OnboardingIpcChannel = {
  GetOnboardingState: "desktop:get-onboarding-state",
  MarkDashboardWelcomeSeen: "desktop:mark-dashboard-welcome-seen",
  CompleteOnboarding: "desktop:complete-onboarding",
  StartDeviceOnboarding: "desktop:start-device-onboarding",
  DismissOnboardingPopup: "desktop:dismiss-onboarding-popup",
  OnboardingPopupCta: "desktop:onboarding-popup-cta",
  SetSyncObservabilityTier: "desktop:set-sync-observability-tier",
  GetDataSyncLevel: "desktop:get-data-sync-level",
  SetDataSyncLevel: "desktop:set-data-sync-level",
  GetSyncConsentRecord: "desktop:get-sync-consent-record",
  RecordSyncConsent: "desktop:record-sync-consent",
} as const;

export type OnboardingIpcChannel =
  (typeof OnboardingIpcChannel)[keyof typeof OnboardingIpcChannel];

/** Renderer-supplied payload for `desktop:complete-onboarding`. */
type CompleteOnboardingPayload = {
  relayOrigin?: string;
  apiOrigin?: string;
  webAppOrigin: string;
  sandboxBaseDirectory: string;
  apiKey?: string;
  onboardingAttemptId?: string;
  bootstrapToken?: string;
  binaryPaths?: Partial<Record<CliBinaryTool, string>>;
};

type IpcMainLike = {
  handle: (
    channel: OnboardingIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type OnboardingIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  settingsStore: SettingsStore;
  apiKeyStore: ApiKeyStore;
  getOnboardingState: () => DesktopOnboardingState;
  cancelManagedOnboardingForUserChange: (reason: string) => void;
  persistActiveProfileKey: (
    apiKey: string,
    provenance: "USER_CREATED" | "DESKTOP_MANAGED"
  ) => void;
  warmTelemetryOrgIdentity: () => void;
  applyBinaryPathPatch: (patch: BinaryPathPatch) => void;
  restartCloudSocket: () => void;
  startDeviceOnboarding: (
    webAppOrigin?: string
  ) => Promise<{ status: "approved" | "pending"; verificationUrl?: string }>;
  /**
   * FEA-3463 follow-up: notify the app when the sync-observability tier is
   * (re)chosen so a lane whose sweep was suppressed while the gate was closed
   * can re-run discovery promptly instead of waiting up to 30 min for the next
   * periodic sweep. Fires on every set (idempotent for the consumer).
   */
  onSyncObservabilityTierChanged?: () => void;
  /**
   * FEA-3907 — persist the graduated data sync level and apply its derived
   * connectivity/sync side effects (in-memory app state + cloud socket/presence
   * updates) in one place. Implemented in app.ts (`applyDataSyncLevel`) so the
   * socket restart, tray, and presence bookkeeping match the legacy per-flag
   * setters; the store write (level + derived booleans) happens there too.
   */
  applyDataSyncLevel: (level: DataSyncLevel) => void;
  /**
   * ISS-5489 — the authenticated session's org, used as the trusted source for
   * the sync-consent binding instead of the renderer-supplied value.
   */
  getSessionOrganizationId: () => string | null;
};

/** Normalize an optional cloud origin, or undefined when absent/blank. */
function resolveOptionalOrigin(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim()
    ? normalizeAndValidateOrigin(value)
    : undefined;
}

/**
 * Validate the manual-onboarding API key. Returns the trimmed key when present
 * (throwing via normalizeClosedloopApiKey if malformed); an empty string means
 * no key was supplied. A supplied onboardingAttemptId with no key is rejected —
 * automated onboarding must come from the installer handoff file.
 */
function resolveOnboardingApiKey(payload: CompleteOnboardingPayload): string {
  const trimmedApiKey =
    typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  if (trimmedApiKey) {
    normalizeClosedloopApiKey(trimmedApiKey);
    return trimmedApiKey;
  }
  const onboardingAttemptId =
    typeof payload.onboardingAttemptId === "string"
      ? payload.onboardingAttemptId.trim()
      : "";
  if (onboardingAttemptId) {
    throw new Error(
      "Automated onboarding must start from the installer handoff file."
    );
  }
  return "";
}

/** Collect the non-empty binary-path overrides from the onboarding payload. */
function buildBinaryPathPatch(
  binaryPaths: Partial<Record<CliBinaryTool, string>>
): BinaryPathPatch {
  const patch: BinaryPathPatch = {};
  for (const key of CLI_BINARY_TOOLS) {
    const value = binaryPaths[key];
    if (typeof value === "string" && value.trim()) {
      patch[key] = value.trim();
    }
  }
  return patch;
}

export function registerOnboardingIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: OnboardingIpcDeps
): void {
  ipcMainLike.handle(OnboardingIpcChannel.GetOnboardingState, () =>
    deps.getOnboardingState()
  );
  // FEA-1333: mark the one-time Agent Dashboard welcome as seen so it does
  // not show again. Separate from desktop:complete-onboarding, which owns
  // the gateway "Setup Required" flow.
  ipcMainLike.handle(OnboardingIpcChannel.MarkDashboardWelcomeSeen, () => {
    deps.settingsStore.setDashboardWelcomeSeen(true);
    return { ok: true };
  });
  ipcMainLike.handle(
    OnboardingIpcChannel.CompleteOnboarding,
    async (event, rawPayload) => {
      // Bootstraps full gateway configuration in one call — API key, cloud
      // origins, sandbox base directory, and CLI binary paths. Input
      // validation below is defense-in-depth; sender trust is the boundary
      // that keeps a compromised/secondary renderer from bootstrapping
      // attacker-controlled configuration.
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const payload = rawPayload as CompleteOnboardingPayload;
      const relayOrigin = resolveOptionalOrigin(payload.relayOrigin);
      const apiOrigin = resolveOptionalOrigin(payload.apiOrigin);
      const webAppOrigin = normalizeWebAppOrigin(payload.webAppOrigin);
      const sandboxBaseDirectory = normalizeScopePath(
        payload.sandboxBaseDirectory
      );
      if (!sandboxBaseDirectory) {
        throw new Error(SANDBOX_REQUIRED_MESSAGE);
      }
      // FEA-3641: reject broad/risky roots (~, /Users/<name>, system dirs) at
      // this selection point too — not just managed onboarding. A sandbox at or
      // above home lets the directory browser / file search stat TCC-protected
      // folders, triggering the excessive macOS permission prompts.
      if (isRiskyAllowedDirectory(sandboxBaseDirectory)) {
        throw new Error(SANDBOX_RISKY_ROOT_MESSAGE);
      }

      const trimmedApiKey = resolveOnboardingApiKey(payload);

      deps.cancelManagedOnboardingForUserChange("manual onboarding completed");
      // ISS-6243: commit the origins BEFORE the credential. Storing the key
      // announces a credential change, and every listener resolves the account
      // by calling `/me` against the CURRENT apiOrigin — so writing the key
      // first points that lookup at the previous cloud. Neither of these writes
      // reads the other, so the swap is safe.
      deps.settingsStore.update({
        ...(relayOrigin === undefined ? {} : { relayOrigin }),
        ...(apiOrigin === undefined ? {} : { apiOrigin }),
        webAppOrigin,
        sandboxBaseDirectory,
        onboardingCompleted: true,
      });
      if (trimmedApiKey) {
        deps.apiKeyStore.setApiKey(trimmedApiKey, "USER_CREATED");
        deps.persistActiveProfileKey(trimmedApiKey, "USER_CREATED");
      }
      // Warm after the apiOrigin is committed so org resolution targets the
      // freshly-configured cloud origin. No-op when no key was set.
      deps.warmTelemetryOrgIdentity();

      if (payload.binaryPaths) {
        const patch = buildBinaryPathPatch(payload.binaryPaths);
        if (Object.keys(patch).length > 0) {
          deps.applyBinaryPathPatch(patch);
        }
      }

      await seedReposConfig(sandboxBaseDirectory);
      deps.restartCloudSocket();
      return deps.getOnboardingState();
    }
  );
  ipcMainLike.handle(
    OnboardingIpcChannel.StartDeviceOnboarding,
    (event, rawPayload) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const payload = rawPayload as { webAppOrigin?: string } | undefined;
      return deps.startDeviceOnboarding(payload?.webAppOrigin);
    }
  );
  ipcMainLike.handle(
    OnboardingIpcChannel.DismissOnboardingPopup,
    (event, rawPayload) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const payload = rawPayload as { permanent?: boolean } | undefined;
      const permanent = payload?.permanent === true;
      if (permanent) {
        deps.settingsStore.setOnboardingPopupDismissedPermanent(true);
        Observability.onboardingPopupDismissedPermanent();
      } else {
        Observability.onboardingPopupDismissedSession();
      }
      return { permanent };
    }
  );
  ipcMainLike.handle(OnboardingIpcChannel.OnboardingPopupCta, async (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    Observability.onboardingPopupCtaClicked();
    const webAppOrigin = deps.settingsStore.getWebAppOrigin();
    const targetUrl = new URL(ONBOARDING_WIZARD_PATH, webAppOrigin).toString();
    // webAppOrigin is a mutable setting; route the built URL through the
    // shared allowlist before openExternal so a tampered origin cannot launch
    // a non-https / non-allowlisted target via the OS.
    if (!isAllowedExternalUrl(targetUrl)) {
      throw new Error("Refusing to open untrusted onboarding URL");
    }
    await shell.openExternal(targetUrl);
    return { opened: targetUrl };
  });
  // PRD-532 (M4) → FEA-4103: legacy sync-consent tier setter, retained as a
  // BACKWARD-COMPAT alias for any older renderer build that still invokes it (the
  // current onboarding + Settings both persist through `setDataSyncLevel`). It no
  // longer writes `syncObservabilityTier` in isolation — that was the last
  // independent consent-tier setter, and writing the tier alone left the other
  // derived flags (transcript lane, connectivity) untouched, so the canonical
  // `DataSyncLevel` the "Data & Sync" UI reads could disagree with the actual
  // enforced egress (a lying UI). The mapping + canonical write lives in the
  // electron-free `applySyncObservabilityTier` helper (so the wiring is unit-
  // testable without booting Electron): the tier is mapped to its canonical level
  // via the SSOT inverse and routed through the SAME `applyDataSyncLevel` path
  // every other consent surface uses, so all four derived booleans are written
  // together and no surface can set a sub-flag out of agreement. Sender trust is
  // the boundary; the tier is additionally validated against the closed literal
  // set as defense-in-depth. `local → off · metadata → metadata · full → full`
  // never widens exposure — but because it routes through the level, the legacy
  // `local` tier now intentionally also tears down cloud connectivity (Off
  // disables the connection), where the old isolated write left it untouched.
  // That teardown is the point: the tier can no longer desync the enforced
  // egress. The response echoes the tier the caller sent (contract-compatible)
  // even though we persist by level.
  ipcMainLike.handle(
    OnboardingIpcChannel.SetSyncObservabilityTier,
    (event, rawTier) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      return applySyncObservabilityTier(deps, rawTier);
    }
  );
  // FEA-3907: read the current graduated data sync level for the Settings
  // "Data & Sync" control. The store returns the recommended default when unset
  // (upgrading installs are migrated on first read), so this never returns null.
  ipcMainLike.handle(OnboardingIpcChannel.GetDataSyncLevel, (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return { level: deps.settingsStore.getDataSyncLevel() };
  });
  // FEA-3907: persist a new data sync level. Sender trust is the boundary; the
  // level is additionally validated against the closed literal set as
  // defense-in-depth. `applyDataSyncLevel` (app.ts) persists the level + derived
  // booleans and applies the connectivity/sync side effects.
  ipcMainLike.handle(
    OnboardingIpcChannel.SetDataSyncLevel,
    (event, rawLevel) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const level = normalizeDataSyncLevel(rawLevel);
      deps.applyDataSyncLevel(level);
      // The level can reopen a suppressed sync lane just like a tier change, so
      // kick discovery now instead of waiting for the next periodic sweep.
      deps.onSyncObservabilityTierChanged?.();
      return { level };
    }
  );
  // ISS-5489: the post-auth consent takeover's read and write. Both are thin
  // trusted-sender guards over the electron-free `sync-consent-apply` module,
  // matching the FEA-4103 `applySyncObservabilityTier` shape, so the logic is
  // exercisable in the `test:node` slice without booting Electron.
  ipcMainLike.handle(OnboardingIpcChannel.GetSyncConsentRecord, (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return readSyncConsentRecord(syncConsentDeps(deps));
  });
  ipcMainLike.handle(
    OnboardingIpcChannel.RecordSyncConsent,
    (event, rawPayload) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      return applySyncConsent(syncConsentDeps(deps), rawPayload);
    }
  );
}

/** Project the onboarding IPC deps onto the consent module's narrower needs. */
function syncConsentDeps(deps: OnboardingIpcDeps): SyncConsentApplyDeps {
  return {
    applyDataSyncLevel: deps.applyDataSyncLevel,
    clearSyncObservabilityTier: () =>
      deps.settingsStore.clearSyncObservabilityTier(),
    getSyncConsentOrganizationId: () =>
      deps.settingsStore.getSyncConsentOrganizationId(),
    getSessionOrganizationId: () => deps.getSessionOrganizationId(),
    getSyncObservabilityTier: () =>
      deps.settingsStore.getSyncObservabilityTier(),
    hasSyncConsentOrganizationBinding: () =>
      deps.settingsStore.hasSyncConsentOrganizationBinding(),
    onSyncObservabilityTierChanged: deps.onSyncObservabilityTierChanged,
    setSyncConsentOrganizationId: (organizationId) =>
      deps.settingsStore.setSyncConsentOrganizationId(organizationId),
  };
}
