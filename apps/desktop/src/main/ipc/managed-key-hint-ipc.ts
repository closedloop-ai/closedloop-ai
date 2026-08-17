import type { ManagedKeyHintState } from "../../shared/contracts.js";
import type { ApiKeyStore } from "../settings/api-key-store.js";
import { shouldShowManagedKeyHint } from "../settings/saved-config.js";
import type { SettingsStore } from "../settings/settings-store.js";

export const ManagedKeyHintIpcChannel = {
  GetManagedKeyHintState: "desktop:get-managed-key-hint-state",
  DismissManagedKeyHint: "desktop:dismiss-managed-key-hint",
} as const;

export type ManagedKeyHintIpcChannel =
  (typeof ManagedKeyHintIpcChannel)[keyof typeof ManagedKeyHintIpcChannel];

type IpcMainLike = {
  handle: (
    channel: ManagedKeyHintIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type ManagedKeyHintIpcDeps = {
  apiKeyStore: ApiKeyStore;
  settingsStore: SettingsStore;
};

/**
 * Build the persisted "dismissed" state for the managed-key hint. Provenance is
 * sourced from the main-process apiKeyStore only — never from renderer IPC args.
 */
function buildDismissState(apiKeyStore: ApiKeyStore): {
  dismissedAt: string;
  lastSeenProvenance: "DESKTOP_MANAGED" | "USER_CREATED";
} {
  const provenance = apiKeyStore.getApiKeyProvenance() ?? "USER_CREATED";
  return {
    dismissedAt: new Date().toISOString(),
    lastSeenProvenance: provenance,
  };
}

export function registerManagedKeyHintIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: ManagedKeyHintIpcDeps
): void {
  ipcMainLike.handle(
    ManagedKeyHintIpcChannel.GetManagedKeyHintState,
    (): ManagedKeyHintState => {
      try {
        const provenance = deps.apiKeyStore.getApiKeyProvenance();
        const dismissedAt = deps.settingsStore.getManagedKeyHintDismissedAt();
        const lastSeenProvenance =
          deps.settingsStore.getManagedKeyHintLastSeenProvenance();
        const shouldShow = shouldShowManagedKeyHint(
          provenance,
          dismissedAt,
          lastSeenProvenance
        );
        return { provenance, shouldShow };
      } catch {
        // Fail-closed: return safe default if apiKeyStore or settingsStore throws.
        return { shouldShow: false, provenance: null };
      }
    }
  );
  ipcMainLike.handle(
    ManagedKeyHintIpcChannel.DismissManagedKeyHint,
    (): { success: boolean } => {
      try {
        // Security: provenance is sourced from main-process apiKeyStore only —
        // renderer is untrusted; we must never accept provenance from IPC event args.
        const { dismissedAt, lastSeenProvenance } = buildDismissState(
          deps.apiKeyStore
        );
        deps.settingsStore.setManagedKeyHintDismissedAt(dismissedAt);
        deps.settingsStore.setManagedKeyHintLastSeenProvenance(
          lastSeenProvenance
        );
        return { success: true };
      } catch {
        return { success: false };
      }
    }
  );
}
