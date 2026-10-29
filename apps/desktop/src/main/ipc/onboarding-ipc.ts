import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { shell } from "electron";
import { z } from "zod";
import { CLI_BINARY_TOOLS } from "../../shared/cli-binary-tools.js";
import {
  normalizeDataSyncLevel,
  syncObservabilityTierToDataSyncLevel,
} from "../../shared/data-sync-level.js";
import { DesktopRendererEventChannel } from "../../shared/desktop-renderer-event-channel.js";
import { OnboardingIpcChannel } from "../../shared/onboarding-ipc-channel.js";
import {
  SANDBOX_REQUIRED_MESSAGE,
  SANDBOX_RISKY_ROOT_MESSAGE,
} from "../../shared/sandbox-messages.js";
import {
  isRiskyAllowedDirectory,
  normalizeScopePath,
} from "../../shared/sandbox-policy.js";
import { normalizeSyncObservabilityTier } from "../../shared/sync-observability-tier.js";
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

/**
 * Push channel: main → renderer whenever this device's sync-consent answer is
 * (re)written, carrying the post-write consent record.
 *
 * ISS-5489. The renderer's consent snapshot is shared by the read-source
 * decision, the takeover gate and the arrival nudge; before this channel existed
 * a write reached only the surface that made it, so answering "Full" left the
 * app reading local and saying sync was off until the next launch.
 */
export const DESKTOP_SYNC_CONSENT_CHANGED_CHANNEL =
  DesktopRendererEventChannel.SyncConsentChanged;

const onboardingBinaryPathShape = Object.fromEntries(
  CLI_BINARY_TOOLS.map((tool) => [tool, z.string().optional()])
) as Record<CliBinaryTool, z.ZodOptional<z.ZodString>>;

/** Renderer-supplied payload for `desktop:complete-onboarding`. */
const completeOnboardingPayloadSchema = z.object({
  relayOrigin: z.string().optional(),
  apiOrigin: z.string().optional(),
  webAppOrigin: z.string(),
  sandboxBaseDirectory: z.string(),
  apiKey: z.string().optional(),
  onboardingAttemptId: z.string().optional(),
  bootstrapToken: z.string().optional(),
  binaryPaths: z.object(onboardingBinaryPathShape).optional(),
});

type CompleteOnboardingPayload = z.infer<
  typeof completeOnboardingPayloadSchema
>;

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
   * ISS-5489 — best-effort push to the renderer window (the crash-safe
   * `DesktopWindow.sendToRenderer`, which already guards every teardown state).
   * Optional so a caller that has no window — the `test:node` harness, a
   * version-skewed composition root — degrades to no push rather than throwing;
   * the renderer's own `refresh()` is the fallback either way.
   */
  sendToRenderer?: (channel: string, ...args: unknown[]) => void;
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
  /**
   * ISS-10890: re-read the analysis consent gate after the Welcome Start
   * agreement is recorded, so a boot import parked on it starts now.
   */
  onSessionAnalysisAgreed: () => void;
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
  // ISS-5489: the ONE post-write notification, shared by all three
  // renderer-originated consent writes (`SetSyncObservabilityTier`,
  // `SetDataSyncLevel`, `RecordSyncConsent`). Each of them already called the
  // lane kick; the broadcast rides the same call so a fourth write path cannot
  // acquire one without the other. The record is READ here, after the write, so
  // the renderer receives what was actually committed rather than what was
  // requested — and it comes from `readSyncConsentRecord`, so the pushed shape
  // cannot drift from the pulled one.
  const notifySyncConsentChanged = () => {
    deps.onSyncObservabilityTierChanged?.();
    deps.sendToRenderer?.(
      DESKTOP_SYNC_CONSENT_CHANGED_CHANNEL,
      readSyncConsentRecord(syncConsentDeps(deps))
    );
  };
  ipcMainLike.handle(OnboardingIpcChannel.GetOnboardingState, (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return deps.getOnboardingState();
  });
  // FEA-1333: mark the one-time Agent Dashboard welcome as seen so it does
  // not show again. Separate from desktop:complete-onboarding, which owns
  // the gateway "Setup Required" flow.
  ipcMainLike.handle(OnboardingIpcChannel.MarkDashboardWelcomeSeen, (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
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
      if (deps.settingsStore.getSignOutCleanupState().isPending()) {
        throw new Error("onboarding is unavailable during sign-out cleanup");
      }
      const payload = completeOnboardingPayloadSchema.parse(rawPayload);
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
  // PRD-532 (M4) / ISS-8353: legacy sync-consent tier setter, retained as a
  // BACKWARD-COMPAT alias for older renderer builds. It now records active-org
  // consent through the same writer as the takeover and Settings v2, then echoes
  // the legacy tier shape the caller expects.
  ipcMainLike.handle(
    OnboardingIpcChannel.SetSyncObservabilityTier,
    (event, rawTier) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const tier = normalizeSyncObservabilityTier(rawTier);
      applySyncConsent(syncConsentDeps(deps, notifySyncConsentChanged), {
        level: syncObservabilityTierToDataSyncLevel(tier),
      });
      return { tier };
    }
  );
  // FEA-3907: read the current graduated data sync level for the Settings
  // "Data & Sync" control. The store returns the recommended default when unset
  // (upgrading installs are migrated on first read), so this never returns null.
  ipcMainLike.handle(OnboardingIpcChannel.GetDataSyncLevel, (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return { level: deps.settingsStore.getDataSyncLevel() };
  });
  // FEA-3907 / ISS-8353: persist a new data sync level as active-org consent.
  // The shared writer still reaches `applyDataSyncLevel`, but current Settings
  // writes can no longer produce a legacy unbound record.
  ipcMainLike.handle(
    OnboardingIpcChannel.SetDataSyncLevel,
    (event, rawLevel) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const level = normalizeDataSyncLevel(rawLevel);
      const committed = applySyncConsent(
        syncConsentDeps(deps, notifySyncConsentChanged),
        { level }
      );
      return { level: committed.level };
    }
  );
  // ISS-5489: the post-auth consent takeover's read and write. Both are thin
  // trusted-sender guards over the electron-free `sync-consent-apply` module,
  // so the logic is exercisable in the `test:node` slice without booting
  // Electron.
  ipcMainLike.handle(OnboardingIpcChannel.GetSyncConsentRecord, (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return readSyncConsentRecord(syncConsentDeps(deps));
  });
  ipcMainLike.handle(
    OnboardingIpcChannel.RecordSyncConsent,
    (event, rawPayload) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      return applySyncConsent(
        syncConsentDeps(deps, notifySyncConsentChanged),
        rawPayload
      );
    }
  );
  // ISS-10890: Welcome's Start is this device's agreement to local analysis
  // (operator decision, 2026-09-24). Takes no payload; egress is not touched.
  ipcMainLike.handle(
    OnboardingIpcChannel.RecordSessionAnalysisAgreement,
    (event) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      deps.settingsStore.recordSessionAnalysisAgreement();
      deps.onSessionAnalysisAgreed();
      return { ok: true };
    }
  );
}

/**
 * Project the onboarding IPC deps onto the consent module's narrower needs.
 *
 * `onSyncObservabilityTierChanged` is a PARAMETER rather than a projection of
 * the dep with the same name: the read path passes none, and the write path
 * passes the post-write notifier, which itself calls this projection to read the
 * committed record. Threading the notifier through the returned object would
 * make that read reachable from the write it is reporting on.
 */
function syncConsentDeps(
  deps: OnboardingIpcDeps,
  onSyncObservabilityTierChanged?: () => void
): SyncConsentApplyDeps {
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
    onSyncObservabilityTierChanged,
    setSyncConsentOrganizationId: (organizationId) =>
      deps.settingsStore.setSyncConsentOrganizationId(organizationId),
  };
}
