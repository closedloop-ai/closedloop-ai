import type {
  AlwaysAllowRule,
  DesktopSettings,
} from "../../shared/contracts.js";
import {
  DESKTOP_TRANSCRIPT_SYNC_FEATURE_FLAG_KEY,
  type FlagKey,
} from "../../shared/feature-flags.js";
import {
  normalizeScopePath,
  validateSandboxBaseDirectory,
} from "../../shared/sandbox-policy.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { ApiKeyStore } from "../settings/api-key-store.js";
import {
  normalizeAndValidateOrigin,
  normalizeWebAppOrigin,
} from "../settings/origin-policy.js";
import { seedReposConfig } from "../settings/seed-repos-config.js";
import type { SettingsStore } from "../settings/settings-store.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

export const SettingsIpcChannel = {
  GetSettings: "desktop:get-settings",
  UpdateSettings: "desktop:update-settings",
} as const;

export type SettingsIpcChannel =
  (typeof SettingsIpcChannel)[keyof typeof SettingsIpcChannel];

type ApprovalTier = "auto" | "none" | "low" | "medium" | "high";

/** Renderer-supplied payload for `desktop:update-settings`. */
type UpdateSettingsPayload = Partial<Record<FlagKey, boolean>> & {
  sandboxBaseDirectory?: string;
  onboardingCompleted?: boolean;
  relayOrigin?: string;
  apiOrigin?: string;
  webAppOrigin?: string;
  defaultApprovalTier?: ApprovalTier;
  autoApprovalRules?: Record<string, ApprovalTier>;
  verboseLogging?: boolean;
};

type IpcMainLike = {
  handle: (
    channel: SettingsIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type SettingsIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  settingsStore: SettingsStore;
  apiKeyStore: ApiKeyStore;
  pruneAlwaysAllowRules: (
    rules: AlwaysAllowRule[] | undefined
  ) => AlwaysAllowRule[];
  isGoldenMode: () => boolean;
  cancelManagedOnboardingForUserChange: (reason: string) => void;
  getCloudCommandsPaused: () => boolean;
  setCloudCommandsPaused: (paused: boolean) => void;
  getCloudConnectionEnabled: () => boolean;
  setCloudConnectionEnabled: (enabled: boolean) => void;
  sendFlagsChanged: () => void;
  restartCloudSocket: () => void;
  /**
   * FEA-3741 (slice 1): restart the Agent Dashboard collectors so a per-tool
   * collector toggle change takes effect immediately (stop/resume the harness's
   * watcher + tool-home walk). Invoked only when a `collect*Enabled` flag
   * actually changes.
   */
  restartCollectors: () => void;
};

/**
 * FEA-3741 (slice 1): the per-tool collector-enable flag keys. A change to any
 * of these restarts collectors so the toggle takes effect without a relaunch.
 */
const COLLECTOR_TOGGLE_KEYS = [
  "collectClaudeEnabled",
  "collectCursorEnabled",
  "collectCopilotEnabled",
] as const;

/**
 * FEA-4103: the consent-tier sub-flags that are DERIVED from the canonical
 * `DataSyncLevel` and therefore must not be persisted independently through the
 * generic `desktop:update-settings` path. Stripped from every update partial so
 * no surface can set the transcript lane / observability tier out of agreement
 * with the level the "Data & Sync" UI shows. Uses the shared flag-key constant
 * for `transcriptSyncEnabled` so the two never drift. `syncObservabilityTier` is
 * included as a string literal because it is a nullable settings field, not a
 * registered boolean feature flag.
 */
const DATA_SYNC_LEVEL_DERIVED_CONSENT_KEYS = [
  DESKTOP_TRANSCRIPT_SYNC_FEATURE_FLAG_KEY,
  "syncObservabilityTier",
] as const;

/**
 * Normalize an update payload into the partial that gets persisted: FEA-4103
 * consent-tier derived-key strip (the {@link DATA_SYNC_LEVEL_DERIVED_CONSENT_KEYS}
 * are removed FIRST so the generic path can never set them out of agreement with
 * the canonical `DataSyncLevel`), golden-mode cloud lockout, legacy "auto"
 * approval-tier → "high", and origin validation. Mirrors the original inline
 * sequence (including the redundant boolean re-copies that guard against
 * non-boolean flag values reaching the store).
 */
function buildNextUpdatePartial(
  partial: UpdateSettingsPayload,
  isGoldenMode: boolean
): UpdateSettingsPayload {
  const nextPartial: UpdateSettingsPayload = { ...partial };
  // FEA-4103: the consent-tier sub-flags are DERIVED from the canonical
  // `DataSyncLevel` and must never be settable independently through this
  // generic path — a stray `transcriptSyncEnabled`/`syncObservabilityTier` write
  // here would desync the level from the enforced egress, so the "Data & Sync"
  // level UI would misrepresent what actually leaves the device (a lying UI).
  // Strip them: the ONLY sanctioned way to change them is `setDataSyncLevel`
  // (→ `applyDataSyncLevel`), which writes level + all derived booleans together.
  // The operational connectivity/pause flags (`cloudConnectionEnabled`,
  // `cloudCommandsPaused`) stay settable here — they are orthogonal live controls
  // owned by the Relay/Gateway tab, and `getDataSyncLevel` reconciles the
  // displayed level against them so it can never lie about connectivity either.
  for (const derivedConsentKey of DATA_SYNC_LEVEL_DERIVED_CONSENT_KEYS) {
    if (derivedConsentKey in nextPartial) {
      delete (nextPartial as Record<string, unknown>)[derivedConsentKey];
    }
  }
  if (isGoldenMode) {
    // FEA-2648: golden mode hard-disables cloud egress — the bulk persist below
    // must not flip the stored cloud toggle either.
    nextPartial.cloudConnectionEnabled = undefined;
  }
  // Normalize legacy "auto" tier to "high" (they behave identically)
  if (nextPartial.defaultApprovalTier === "auto") {
    nextPartial.defaultApprovalTier = "high";
  }
  if (nextPartial.autoApprovalRules) {
    for (const [key, val] of Object.entries(nextPartial.autoApprovalRules)) {
      if (val === "auto") {
        nextPartial.autoApprovalRules[key] = "high";
      }
    }
  }
  if (typeof partial.relayOrigin === "string") {
    nextPartial.relayOrigin = normalizeAndValidateOrigin(partial.relayOrigin);
  }
  if (typeof partial.apiOrigin === "string") {
    nextPartial.apiOrigin = normalizeAndValidateOrigin(partial.apiOrigin);
  }
  if (typeof partial.webAppOrigin === "string") {
    nextPartial.webAppOrigin = normalizeWebAppOrigin(partial.webAppOrigin);
  }
  if (typeof partial.commandSigningEnforcementEnabled === "boolean") {
    nextPartial.commandSigningEnforcementEnabled =
      partial.commandSigningEnforcementEnabled;
  }
  if (typeof partial.planExtractionEnabled === "boolean") {
    nextPartial.planExtractionEnabled = partial.planExtractionEnabled;
  }
  return nextPartial;
}

/**
 * Apply the in-memory side effects a settings update triggers, after the store
 * is persisted: verbose logging, agent-monitor toggle, cloud pause/connection,
 * repo seeding on sandbox change, and the renderer flags-changed notification.
 */
async function applySettingsSideEffects(
  deps: SettingsIpcDeps,
  ctx: {
    partial: UpdateSettingsPayload;
    nextPartial: UpdateSettingsPayload;
    currentSettings: DesktopSettings;
    selectedSandbox: string | null;
  }
): Promise<void> {
  const { partial, nextPartial, currentSettings, selectedSandbox } = ctx;
  if (typeof nextPartial.verboseLogging === "boolean") {
    gatewayLog.setVerbose(nextPartial.verboseLogging);
  }
  if (
    typeof nextPartial.cloudCommandsPaused === "boolean" &&
    nextPartial.cloudCommandsPaused !== deps.getCloudCommandsPaused()
  ) {
    deps.setCloudCommandsPaused(nextPartial.cloudCommandsPaused);
  }
  if (
    typeof nextPartial.cloudConnectionEnabled === "boolean" &&
    nextPartial.cloudConnectionEnabled !== deps.getCloudConnectionEnabled()
  ) {
    deps.setCloudConnectionEnabled(nextPartial.cloudConnectionEnabled);
  }
  if (
    typeof partial.sandboxBaseDirectory === "string" &&
    selectedSandbox &&
    selectedSandbox !== normalizeScopePath(currentSettings.sandboxBaseDirectory)
  ) {
    await seedReposConfig(selectedSandbox);
    // Repo seeding is a setup convenience only; dashboard ingest is not
    // scoped by the sandbox directory.
  }
  // FEA-3741 (slice 1): if a per-tool collector toggle actually changed value,
  // restart collectors so it takes effect immediately (stop/resume that
  // harness's watcher + tool-home walk) without a relaunch.
  const collectorToggleChanged = COLLECTOR_TOGGLE_KEYS.some((key) => {
    const next = nextPartial[key];
    return typeof next === "boolean" && next !== currentSettings[key];
  });
  if (collectorToggleChanged) {
    deps.restartCollectors();
  }
  // Notify renderer of flag changes so the Feature Flags panel can refresh.
  deps.sendFlagsChanged();
  deps.restartCloudSocket();
}

export function registerSettingsIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: SettingsIpcDeps
): void {
  ipcMainLike.handle(SettingsIpcChannel.GetSettings, () => {
    const settings = deps.settingsStore.getAll();
    const activeAlwaysAllowRules = deps.pruneAlwaysAllowRules(
      settings.alwaysAllowRules
    );
    if (activeAlwaysAllowRules.length !== settings.alwaysAllowRules.length) {
      deps.settingsStore.setAlwaysAllowRules(activeAlwaysAllowRules);
    }
    return {
      ...settings,
      alwaysAllowRules: activeAlwaysAllowRules,
      savedConfigs: settings.savedConfigs.map((config) => ({
        ...config,
        hasCloudApiKey: Boolean(deps.apiKeyStore.getProfileKey(config.id)),
      })),
    };
  });
  ipcMainLike.handle(
    SettingsIpcChannel.UpdateSettings,
    async (event, rawPartial) => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const partial = rawPartial as UpdateSettingsPayload;
      if ("binaryPaths" in partial) {
        throw new Error(
          "binaryPaths must be updated via PATCH /api/gateway/settings/binary-paths"
        );
      }
      const currentSettings = deps.settingsStore.getAll();
      const nextPartial = buildNextUpdatePartial(partial, deps.isGoldenMode());
      // ISS-4577 (shafty review): when a NEW sandbox is being set, run it through
      // the authoritative `validateSandboxBaseDirectory`, which both enforces the
      // FEA-3641 risky-root guard (so the sandbox can never be silently
      // re-pointed at ~ / /Users/<name>) AND returns the *canonicalized* real
      // directory. Persisting the canonical dir — not the mutable lexical alias —
      // closes the symlink-retarget window: a link saved while pointing at a safe
      // project cannot later be repointed at home to widen the enforced scope,
      // because the saved value is the realpath at save time. When no sandbox is
      // being set we keep the existing stored value as the effective selection
      // (lexically normalized, matching prior behavior) for the downstream
      // onboarding-completion and repo-seeding checks.
      const selectedSandbox =
        typeof partial.sandboxBaseDirectory === "string"
          ? validateSandboxBaseDirectory(partial.sandboxBaseDirectory)
          : normalizeScopePath(currentSettings.sandboxBaseDirectory);
      if (typeof partial.sandboxBaseDirectory === "string") {
        // `validateSandboxBaseDirectory` throws SANDBOX_REQUIRED / RISKY_ROOT for
        // blank/risky input, so `selectedSandbox` here is the canonical real dir.
        nextPartial.sandboxBaseDirectory = selectedSandbox ?? undefined;
      }
      if (
        typeof partial.onboardingCompleted === "boolean" &&
        partial.onboardingCompleted &&
        !selectedSandbox
      ) {
        throw new Error(
          "Complete onboarding requires a sandbox base directory"
        );
      }

      const updatesOnboardingState = (
        [
          "sandboxBaseDirectory",
          "onboardingCompleted",
          "relayOrigin",
          "apiOrigin",
          "webAppOrigin",
        ] as const
      ).some((key) => key in partial);
      if (updatesOnboardingState) {
        deps.cancelManagedOnboardingForUserChange(
          "settings were updated manually"
        );
      }

      const updated = deps.settingsStore.update(
        nextPartial as Partial<DesktopSettings>
      );
      await applySettingsSideEffects(deps, {
        partial,
        nextPartial,
        currentSettings,
        selectedSandbox,
      });
      return updated;
    }
  );
}
