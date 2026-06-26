import type { ApiKeyProvenance, SavedConfig } from "../shared/contracts.js";
import type { ApiKeyStore } from "./api-key-store.js";
import type {
  SavedConfigManagedPatch,
  SettingsStore,
} from "./settings-store.js";

export const ProfileConfigIpcChannel = {
  ApplyConfig: "desktop:apply-config",
  DeleteConfig: "desktop:delete-config",
  FindMatchingConfig: "desktop:find-matching-config",
  ListConfigs: "desktop:list-configs",
  RenameConfig: "desktop:rename-config",
  SaveConfig: "desktop:save-config",
} as const;

export type ProfileConfigIpcChannel =
  (typeof ProfileConfigIpcChannel)[keyof typeof ProfileConfigIpcChannel];

export const PROFILE_CONFIG_IPC_CHANNELS = Object.values(
  ProfileConfigIpcChannel
);

type IpcMainLike = {
  handle: (
    channel: ProfileConfigIpcChannel,
    listener: (event: unknown, payload?: unknown) => unknown
  ) => void;
};

type GatewaySnapshot = {
  gatewayPort: number | null;
  computeTarget: string | null;
};

type ConfigConnectionPatch = Partial<
  Pick<SavedConfig, "name" | "relayOrigin" | "apiOrigin" | "webAppOrigin"> &
    GatewaySnapshot
>;

type ActiveKeyCopy = {
  apiKey: string;
  provenance: ApiKeyProvenance;
};

type CreatedProfileConfig = {
  activeKey: ActiveKeyCopy | null;
  savedConfig: SavedConfig;
  shouldCancelManagedOnboarding: boolean;
  shouldActivate: boolean;
};

type ProfileConfigIpcDeps = {
  settingsStore: SettingsStore;
  apiKeyStore: ApiKeyStore;
  getGatewaySnapshot: () => GatewaySnapshot;
  cancelManagedOnboardingForUserChange: (reason: string) => void;
  onActiveConfigDeleted: () => void;
  onConfigDeleted: (config: { gatewayId?: string } | undefined) => void;
  restartCloudSocket: () => void;
  isEncryptionAvailable: () => boolean;
};

export function normalizeClosedloopApiKey(apiKey: unknown): string {
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmed.startsWith("sk_live_")) {
    throw new Error("API key must start with sk_live_");
  }
  return trimmed;
}

function normalizeOptionalClosedloopApiKey(apiKey: unknown): string {
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  return trimmed ? normalizeClosedloopApiKey(trimmed) : "";
}

function getPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function getConfigConnectionPatch(
  payload: Record<string, unknown>,
  snapshot: GatewaySnapshot | null,
  includeName: boolean
): ConfigConnectionPatch {
  return {
    ...(includeName && payload.name !== undefined
      ? { name: String(payload.name) }
      : {}),
    ...(payload.relayOrigin === undefined
      ? {}
      : { relayOrigin: String(payload.relayOrigin) }),
    ...(payload.apiOrigin === undefined
      ? {}
      : { apiOrigin: String(payload.apiOrigin) }),
    ...(payload.webAppOrigin === undefined
      ? {}
      : { webAppOrigin: String(payload.webAppOrigin) }),
    ...(snapshot ?? {}),
  };
}

function assertCanPersistExplicitProfileKey(
  deps: ProfileConfigIpcDeps,
  apiKey: string
): void {
  if (apiKey && !deps.isEncryptionAvailable()) {
    throw new Error("safeStorage is not available on this system");
  }
}

function persistUserCreatedProfileKey(
  deps: ProfileConfigIpcDeps,
  savedConfigId: string,
  apiKey: string
): SavedConfig {
  deps.apiKeyStore.saveProfileKey(savedConfigId, apiKey, "USER_CREATED");
  return deps.settingsStore.updateConfigManagedMetadata(savedConfigId, {
    apiKeySource: "USER_CREATED",
  });
}

function getStoredActiveKeyCopy(
  deps: ProfileConfigIpcDeps
): (ActiveKeyCopy & { originalProvenance: ApiKeyProvenance }) | null {
  if (deps.apiKeyStore.getStatus().source !== "safeStorage") {
    return null;
  }
  const apiKey = deps.apiKeyStore.getApiKey() ?? "";
  if (!apiKey) {
    return null;
  }
  const originalProvenance =
    deps.apiKeyStore.getApiKeyProvenance() ?? "USER_CREATED";
  const provenance =
    originalProvenance === "DESKTOP_MANAGED"
      ? "USER_CREATED"
      : originalProvenance;
  return { apiKey, originalProvenance, provenance };
}

function getCopiedKeyManagedPatch(
  deps: ProfileConfigIpcDeps,
  savedConfigId: string,
  copy: ActiveKeyCopy & { originalProvenance: ApiKeyProvenance }
): SavedConfigManagedPatch {
  const patch: SavedConfigManagedPatch = {
    apiKeySource: copy.provenance,
  };
  if (copy.originalProvenance !== "DESKTOP_MANAGED") {
    return patch;
  }
  const profileGateway =
    deps.settingsStore.ensureConfigGatewayId(savedConfigId);
  return {
    ...patch,
    gatewayId: profileGateway.gatewayId,
    desktopSecurityUpgradeProtocolVersion: 1,
  };
}

function copyStoredActiveKeyToProfile(
  deps: ProfileConfigIpcDeps,
  savedConfig: SavedConfig
): CreatedProfileConfig {
  const copy = getStoredActiveKeyCopy(deps);
  if (!copy) {
    return {
      activeKey: null,
      savedConfig,
      shouldActivate: true,
      shouldCancelManagedOnboarding: false,
    };
  }
  deps.apiKeyStore.saveProfileKey(savedConfig.id, copy.apiKey, copy.provenance);
  const managedPatch = getCopiedKeyManagedPatch(deps, savedConfig.id, copy);
  const activeKey =
    copy.originalProvenance === "DESKTOP_MANAGED"
      ? null
      : { apiKey: copy.apiKey, provenance: copy.provenance };
  return {
    activeKey,
    savedConfig: deps.settingsStore.updateConfigManagedMetadata(
      savedConfig.id,
      managedPatch
    ),
    shouldActivate: copy.originalProvenance !== "DESKTOP_MANAGED",
    shouldCancelManagedOnboarding: false,
  };
}

function updateExistingProfileConfig(
  deps: ProfileConfigIpcDeps,
  profileId: string,
  payload: Record<string, unknown>,
  snapshot: GatewaySnapshot | null,
  explicitApiKey: string
): SavedConfig {
  const updatedConfig = deps.settingsStore.updateConfigConnection(
    profileId,
    getConfigConnectionPatch(payload, snapshot, true)
  );
  return explicitApiKey
    ? persistUserCreatedProfileKey(deps, updatedConfig.id, explicitApiKey)
    : updatedConfig;
}

function createProfileConfig(
  deps: ProfileConfigIpcDeps,
  payload: Record<string, unknown>,
  snapshot: GatewaySnapshot,
  explicitApiKey: string
): CreatedProfileConfig {
  const savedConfig = deps.settingsStore.saveConfig(
    typeof payload.name === "string" ? payload.name : "",
    getConfigConnectionPatch(payload, snapshot, false)
  );
  if (explicitApiKey) {
    return {
      activeKey: { apiKey: explicitApiKey, provenance: "USER_CREATED" },
      savedConfig: persistUserCreatedProfileKey(
        deps,
        savedConfig.id,
        explicitApiKey
      ),
      shouldCancelManagedOnboarding: true,
      shouldActivate: true,
    };
  }
  return copyStoredActiveKeyToProfile(deps, savedConfig);
}

function refreshActiveProfileAfterSave(
  deps: ProfileConfigIpcDeps,
  savedConfig: SavedConfig,
  explicitApiKey: string
): void {
  deps.cancelManagedOnboardingForUserChange(
    "the active saved config was updated"
  );
  deps.settingsStore.applyConfig(savedConfig.id);
  if (explicitApiKey) {
    deps.apiKeyStore.setApiKey(explicitApiKey, "USER_CREATED");
  }
  deps.restartCloudSocket();
}

function activateCreatedProfile(
  deps: ProfileConfigIpcDeps,
  savedConfig: SavedConfig,
  activeKey: ActiveKeyCopy | null
): void {
  deps.settingsStore.setActiveConfigId(savedConfig.id);
  deps.settingsStore.applyConfig(savedConfig.id);
  if (activeKey) {
    deps.apiKeyStore.setApiKey(activeKey.apiKey, activeKey.provenance);
  }
  deps.restartCloudSocket();
}

export function registerProfileConfigIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: ProfileConfigIpcDeps
): void {
  ipcMainLike.handle(ProfileConfigIpcChannel.FindMatchingConfig, () => {
    return deps.settingsStore.findConfigByOrigins(
      deps.settingsStore.getRelayOrigin(),
      deps.settingsStore.getApiOrigin(),
      deps.settingsStore.getWebAppOrigin()
    );
  });

  ipcMainLike.handle(
    ProfileConfigIpcChannel.SaveConfig,
    (_event, rawPayload) => {
      const payload = getPayloadRecord(rawPayload);
      const snapshot = deps.getGatewaySnapshot();
      const explicitApiKey = normalizeOptionalClosedloopApiKey(payload.apiKey);
      assertCanPersistExplicitProfileKey(deps, explicitApiKey);
      const activeConfigId = deps.settingsStore.getActiveConfigId();
      const profileId = typeof payload.id === "string" ? payload.id : "";

      if (profileId) {
        const isActiveProfile = activeConfigId === profileId;
        const savedConfig = updateExistingProfileConfig(
          deps,
          profileId,
          payload,
          isActiveProfile ? snapshot : null,
          explicitApiKey
        );
        if (isActiveProfile) {
          refreshActiveProfileAfterSave(deps, savedConfig, explicitApiKey);
        }
        return savedConfig;
      }

      const {
        activeKey,
        savedConfig,
        shouldActivate,
        shouldCancelManagedOnboarding,
      } = createProfileConfig(deps, payload, snapshot, explicitApiKey);
      if (shouldActivate) {
        if (shouldCancelManagedOnboarding) {
          deps.cancelManagedOnboardingForUserChange(
            "a saved config with a manual API key was created"
          );
        }
        activateCreatedProfile(deps, savedConfig, activeKey);
      }
      return savedConfig;
    }
  );

  ipcMainLike.handle(ProfileConfigIpcChannel.ListConfigs, () => {
    return deps.settingsStore.listConfigs().map((config) => ({
      ...config,
      hasCloudApiKey: Boolean(deps.apiKeyStore.getProfileKey(config.id)),
    }));
  });

  ipcMainLike.handle(
    ProfileConfigIpcChannel.DeleteConfig,
    (_event, rawPayload) => {
      const payload = getPayloadRecord(rawPayload);
      const id = typeof payload.id === "string" ? payload.id : "";
      if (!id) {
        throw new Error("id is required");
      }
      const config = deps.settingsStore.listConfigs().find((c) => c.id === id);
      const { wasActive } = deps.settingsStore.deleteConfig(id);
      if (wasActive) {
        deps.onActiveConfigDeleted();
      }
      deps.apiKeyStore.deleteProfileKey(id);
      deps.onConfigDeleted(config);
      return { wasActive };
    }
  );

  ipcMainLike.handle(
    ProfileConfigIpcChannel.RenameConfig,
    (_event, rawPayload) => {
      const payload = getPayloadRecord(rawPayload);
      const id = typeof payload.id === "string" ? payload.id : "";
      if (!id) {
        throw new Error("id is required");
      }
      deps.settingsStore.renameConfig(
        id,
        typeof payload.name === "string" ? payload.name : ""
      );
    }
  );

  ipcMainLike.handle(
    ProfileConfigIpcChannel.ApplyConfig,
    (_event, rawPayload) => {
      const payload = getPayloadRecord(rawPayload);
      const id = typeof payload.id === "string" ? payload.id : "";
      if (!id) {
        throw new Error("id is required");
      }
      if (!deps.isEncryptionAvailable()) {
        throw new Error("safeStorage is not available -- cannot apply config");
      }
      deps.cancelManagedOnboardingForUserChange("a saved config was applied");
      const appliedConfig = deps.settingsStore.applyConfig(id);
      const profileKey = deps.apiKeyStore.getProfileKeyRecord(id);
      if (profileKey) {
        const hasManagedIdentity =
          appliedConfig.gatewayId &&
          appliedConfig.gatewayPublicKeyPem &&
          profileKey.provenance === "DESKTOP_MANAGED";
        const provenance = hasManagedIdentity
          ? "DESKTOP_MANAGED"
          : "USER_CREATED";
        deps.apiKeyStore.setApiKey(profileKey.apiKey, provenance);
        deps.settingsStore.updateConfigManagedMetadata(id, {
          apiKeySource: provenance,
        });
      } else {
        deps.apiKeyStore.clearApiKey();
        deps.settingsStore.updateConfigManagedMetadata(id, {
          apiKeySource: "USER_CREATED",
        });
      }
      deps.restartCloudSocket();
      return appliedConfig;
    }
  );
}
