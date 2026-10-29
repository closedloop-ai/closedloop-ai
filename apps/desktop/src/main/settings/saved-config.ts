import { randomUUID } from "node:crypto";
import type { ApiKeyProvenance, SavedConfig } from "../../shared/contracts.js";
import { validateSandboxBaseDirectory } from "../../shared/sandbox-policy.js";
import {
  normalizeAndValidateOrigin,
  normalizeWebAppOrigin,
} from "./origin-policy.js";

/**
 * Saved-config value shapes and the pure helpers over them, split out of
 * `settings-store.ts` (FEA-3907) so that file stays under the 1,000-line ceiling.
 * These are the profile/config patch types the managed-onboarding + profile-IPC
 * paths consume, plus the two pure predicates that need no `SettingsStore`
 * instance and were already unit-tested in isolation.
 */

export type SavedConfigManagedPatch = Partial<
  Pick<
    SavedConfig,
    | "apiKeySource"
    | "gatewayId"
    | "gatewayPublicKeyPem"
    | "desktopSecurityUpgradeProtocolVersion"
    | "lastComputeTargetId"
    | "lastComputeTargetEnvironmentKey"
    | "desktopSecurityPromptDismissedAt"
    | "pendingOnboardingAttemptId"
  >
>;

export type SavedConfigOriginsPatch = Pick<
  SavedConfig,
  "relayOrigin" | "apiOrigin" | "webAppOrigin"
>;

export type SavedConfigSnapshot = {
  gatewayPort?: number | null;
  computeTarget?: string | null;
};

export type SaveConfigOptions = SavedConfigSnapshot &
  Partial<SavedConfigOriginsPatch> &
  Partial<Pick<SavedConfig, "sandboxBaseDirectory">>;

type SavedConfigDefaults = Pick<
  SavedConfig,
  "relayOrigin" | "apiOrigin" | "webAppOrigin"
>;

export type SavedConfigConnectionPatch = Partial<
  Pick<SavedConfig, "name" | "sandboxBaseDirectory"> &
    SavedConfigOriginsPatch &
    SavedConfigSnapshot
>;

export const DEFAULT_MANAGED_ONBOARDING_CONFIG_NAME = "Default";

export const SavedConfigManagedField = {
  ApiKeySource: "apiKeySource",
  GatewayId: "gatewayId",
  GatewayPublicKeyPem: "gatewayPublicKeyPem",
  DesktopSecurityUpgradeProtocolVersion:
    "desktopSecurityUpgradeProtocolVersion",
  LastComputeTargetId: "lastComputeTargetId",
  LastComputeTargetEnvironmentKey: "lastComputeTargetEnvironmentKey",
  DesktopSecurityPromptDismissedAt: "desktopSecurityPromptDismissedAt",
  PendingOnboardingAttemptId: "pendingOnboardingAttemptId",
} as const;

/** Removes every managed-key field while retaining profile preferences. */
export function clearSavedConfigManagedMetadata(
  config: SavedConfig
): SavedConfig {
  const cleared = { ...config };
  let changed = false;
  for (const field of Object.values(SavedConfigManagedField)) {
    if (Object.hasOwn(cleared, field)) {
      Reflect.deleteProperty(cleared, field);
      changed = true;
    }
  }
  return changed ? cleared : config;
}

/** Adds a stable gateway identity only when this profile has none. */
export function ensureSavedConfigGatewayId(config: SavedConfig): SavedConfig {
  if (config.gatewayId && isUuidV4(config.gatewayId)) {
    return config;
  }
  return {
    ...config,
    gatewayId: randomUUID(),
    desktopSecurityUpgradeProtocolVersion: 1,
  };
}

/** Applies a managed-key patch without rewriting an already-equal profile. */
export function applySavedConfigManagedPatch(
  config: SavedConfig,
  patch: SavedConfigManagedPatch
): SavedConfig {
  const changed = Object.entries(patch).some(
    ([key, value]) => config[key as keyof SavedConfig] !== value
  );
  return changed ? { ...config, ...patch } : config;
}

/** Builds one saved profile from normalized runtime defaults and overrides. */
export function createSavedConfig(
  name: string,
  defaults: SavedConfigDefaults,
  options?: SaveConfigOptions
): SavedConfig {
  return {
    id: randomUUID(),
    name,
    relayOrigin:
      options?.relayOrigin === undefined
        ? defaults.relayOrigin
        : normalizeAndValidateOrigin(options.relayOrigin),
    apiOrigin:
      options?.apiOrigin === undefined
        ? defaults.apiOrigin
        : normalizeAndValidateOrigin(options.apiOrigin),
    webAppOrigin:
      options?.webAppOrigin === undefined
        ? defaults.webAppOrigin
        : normalizeWebAppOrigin(options.webAppOrigin),
    apiKeySource: "USER_CREATED",
    gatewayPort: options?.gatewayPort ?? null,
    computeTarget: options?.computeTarget ?? null,
    ...(options?.sandboxBaseDirectory === undefined
      ? {}
      : {
          sandboxBaseDirectory: validateSandboxBaseDirectory(
            options.sandboxBaseDirectory
          ),
        }),
  };
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Determines whether the Settings panel should show the managed-key revival
 * limitation hint (AC-010 / D5).
 *
 * Returns true when:
 * - provenance is not DESKTOP_MANAGED
 * - AND the hint has never been dismissed (dismissedAt is null)
 *   OR the last dismissal was while provenance was DESKTOP_MANAGED (regression
 *   detected — user rotated back to USER_CREATED after pairing).
 *
 * Pure function — exported for unit testing without Electron IPC mocking.
 */
export function shouldShowManagedKeyHint(
  provenance: ApiKeyProvenance | null,
  dismissedAt: string | null,
  lastSeenProvenance: "DESKTOP_MANAGED" | "USER_CREATED" | null
): boolean {
  if (provenance === "DESKTOP_MANAGED") {
    // Key supports revival — never show the hint.
    return false;
  }
  if (dismissedAt === null) {
    // Never dismissed — show.
    return true;
  }
  // Dismissed before, but check if provenance regressed from DESKTOP_MANAGED:
  // if lastSeenProvenance was DESKTOP_MANAGED when dismissed, the user has since
  // rotated back to USER_CREATED — re-show the hint.
  return lastSeenProvenance === "DESKTOP_MANAGED";
}

export function isSavedConfig(value: unknown): value is SavedConfig {
  if (!(value && typeof value === "object")) {
    return false;
  }
  const config = value as Partial<Record<keyof SavedConfig, unknown>>;
  return (
    typeof config.id === "string" &&
    typeof config.name === "string" &&
    typeof config.relayOrigin === "string" &&
    typeof config.apiOrigin === "string" &&
    typeof config.webAppOrigin === "string"
  );
}

/**
 * Coerce a loaded saved config's optional fields to safe shapes. `isSavedConfig`
 * guards only the five always-present string fields, so every optional one is
 * whatever the JSON on disk happened to hold. Each step returns the config
 * unchanged when nothing was wrong — that identity is how `getSavedConfigs`
 * decides whether the sanitized list has to be written back.
 */
export function sanitizeSavedConfig(config: SavedConfig): SavedConfig {
  return sanitizePersistedComputeTarget(sanitizeSandboxBaseDirectory(config));
}

export function isUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value);
}

/**
 * Trims and validates a proposed saved-config name. Pure helper split out of
 * `SettingsStore` (FEA-3907) so the store file stays under the 1,000-line
 * ceiling; it needs no store instance.
 */
export function validateConfigName(name: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    throw new Error("Config name is required");
  }
  if (trimmed.length > 200) {
    throw new Error("Config name must be 200 characters or fewer");
  }
  return trimmed;
}

/**
 * Throws when `name` collides (case-insensitively) with an existing saved
 * config other than `excludeId`. Pure over the passed `configs` list.
 */
export function assertNameAvailable(
  configs: SavedConfig[],
  name: string,
  excludeId?: string
): void {
  const normalized = name.trim().toLocaleLowerCase();
  const clash = configs.find(
    (c) =>
      c.id !== excludeId && c.name.trim().toLocaleLowerCase() === normalized
  );
  if (clash) {
    throw new Error(`A config named "${clash.name}" already exists`);
  }
}

/**
 * Returns a saved-config name derived from `preferredName` that is unique
 * (case-insensitively) among `configs`, appending a numeric suffix on collision.
 * Pure over the passed `configs` list.
 */
export function getAvailableConfigName(
  configs: SavedConfig[],
  preferredName: string
): string {
  const baseName = validateConfigName(preferredName);
  const usedNames = new Set(
    configs.map((config) => config.name.trim().toLocaleLowerCase())
  );
  if (!usedNames.has(baseName.toLocaleLowerCase())) {
    return baseName;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!usedNames.has(candidate.toLocaleLowerCase())) {
      return candidate;
    }
  }
  throw new Error(`No available config name for "${baseName}"`);
}

/**
 * Reconciles each saved config's `apiKeySource` so `DESKTOP_MANAGED` is retained
 * only when the profile still carries a valid managed identity (a v4 gateway UUID
 * plus a public-key PEM); otherwise it falls back to `USER_CREATED`. Pure over the
 * passed list — returns the (possibly identical) reconciled configs plus whether
 * anything changed, so the caller can skip the persist write on a no-op.
 */
export function reconcileManagedApiKeySources(configs: SavedConfig[]): {
  configs: SavedConfig[];
  changed: boolean;
} {
  let changed = false;
  const reconciled = configs.map((config) => {
    const hasManagedIdentity =
      typeof config.gatewayId === "string" &&
      isUuidV4(config.gatewayId) &&
      typeof config.gatewayPublicKeyPem === "string" &&
      config.gatewayPublicKeyPem.includes("BEGIN PUBLIC KEY");
    const apiKeySource: SavedConfig["apiKeySource"] =
      config.apiKeySource === "DESKTOP_MANAGED" && hasManagedIdentity
        ? "DESKTOP_MANAGED"
        : "USER_CREATED";
    if (config.apiKeySource !== apiKeySource) {
      changed = true;
      return { ...config, apiKeySource };
    }
    return config;
  });
  return { configs: reconciled, changed };
}

/**
 * FEA-4005: a persisted `sandboxBaseDirectory` that is `null`, a number, an
 * object, or a blank/whitespace string would otherwise survive to crash
 * `.trim()` in the renderer or throw in `applyConfig`. An invalid or blank value
 * is dropped (omission = "inherit the global sandbox"), matching the version-skew
 * rule that an absent optional field degrades to the safe default.
 */
function sanitizeSandboxBaseDirectory(config: SavedConfig): SavedConfig {
  const { sandboxBaseDirectory } = config;
  if (
    typeof sandboxBaseDirectory === "string" &&
    sandboxBaseDirectory.trim().length > 0
  ) {
    return config;
  }
  if (sandboxBaseDirectory === undefined) {
    return config;
  }
  const { sandboxBaseDirectory: _dropped, ...rest } = config;
  return rest;
}

/**
 * ISS-9003 (whitlockk, #7142): drop a persisted compute-target pair whose id or
 * environment-key half came off disk as something other than a string. A
 * malformed stamp is not inert — `new URL()` stringifies its argument, so a
 * one-element array holding an origin normalizes to a real environment key and
 * re-enables the fallback that origin scope exists to gate, while a two-element
 * one yields `"https://a.test,https"`: precisely the garbage partition key
 * `normalizeEnvironmentKey` promises never to produce. A non-string id is worse
 * still, being handed back to a cloud read as a compute target id.
 *
 * The id and the origin that minted it are one fact, so a corrupt half voids the
 * pair rather than half of it. An absent pair is the already-decided unstamped
 * case: refused by `persistedTargetForOrigin`, and re-stamped by the next hello.
 */
function sanitizePersistedComputeTarget(config: SavedConfig): SavedConfig {
  const { lastComputeTargetId, lastComputeTargetEnvironmentKey, ...rest } =
    config;
  if (
    isNullableString(lastComputeTargetId) &&
    isNullableString(lastComputeTargetEnvironmentKey)
  ) {
    return config;
  }
  return rest;
}

function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}
