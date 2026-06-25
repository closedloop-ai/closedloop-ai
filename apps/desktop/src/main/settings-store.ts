import { randomUUID } from "node:crypto";
import Store from "electron-store";
import {
  type AlwaysAllowRule,
  type ApiKeyProvenance,
  DEFAULT_DESKTOP_SETTINGS,
  type DesktopSettings,
  type RiskTier,
  type SavedConfig,
} from "../shared/contracts.js";
import {
  FEATURE_FLAGS,
  FLAG_KEYS,
  type FlagKey,
  getFlagDefinition,
} from "../shared/feature-flags.js";
import {
  normalizeAndValidateOrigin,
  normalizeWebAppOrigin,
} from "./origin-policy.js";

type BinaryPaths = {
  claude?: string;
  gh?: string;
  codex?: string;
  cursor?: string;
  opencode?: string;
  python3?: string;
  git?: string;
};

export type SavedConfigManagedPatch = Partial<
  Pick<
    SavedConfig,
    | "apiKeySource"
    | "gatewayId"
    | "gatewayPublicKeyPem"
    | "desktopSecurityUpgradeProtocolVersion"
    | "lastComputeTargetId"
    | "desktopSecurityPromptDismissedAt"
    | "pendingOnboardingAttemptId"
  >
>;
type SavedConfigOriginsPatch = Pick<
  SavedConfig,
  "relayOrigin" | "apiOrigin" | "webAppOrigin"
>;
type SavedConfigSnapshot = {
  gatewayPort?: number | null;
  computeTarget?: string | null;
};
type SaveConfigOptions = SavedConfigSnapshot & Partial<SavedConfigOriginsPatch>;
type SavedConfigConnectionPatch = Partial<
  Pick<SavedConfig, "name"> & SavedConfigOriginsPatch & SavedConfigSnapshot
>;

const DEFAULT_MANAGED_ONBOARDING_CONFIG_NAME = "Default";

/**
 * Determines whether the Settings panel should show the managed-key revival
 * limitation hint (AC-010 / D5).
 *
 * Returns true when:
 * - provenance is not DESKTOP_MANAGED (i.e. the key cannot revive timed-out loops)
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
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSavedConfig(value: unknown): value is SavedConfig {
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

export type SettingsStoreOptions = {
  cwd?: string;
  name?: string;
};

export class SettingsStore {
  private readonly store: Store<DesktopSettings>;

  constructor(options?: SettingsStoreOptions) {
    this.store = new Store<DesktopSettings>({
      name: options?.name ?? "desktop-settings",
      cwd: options?.cwd,
    });

    // Migration: delete stale allowedDirectories key from previous versions.
    // electron-store spreads raw persisted data in getAll(), so a stale key
    // would bleed through to IPC responses even after removing it from the type.
    if ("allowedDirectories" in this.store.store) {
      this.store.delete("allowedDirectories" as keyof DesktopSettings);
    }
    // TODO(FEA-1550): remove these migration blocks once all installs have upgraded past 0.16.0
    if ("agentDashboardDesignSystemEnabled" in this.store.store) {
      this.store.delete(
        "agentDashboardDesignSystemEnabled" as keyof DesktopSettings
      );
    }
    if ("agentSessionChunkedSyncEnabled" in this.store.store) {
      this.store.delete(
        "agentSessionChunkedSyncEnabled" as keyof DesktopSettings
      );
    }

    // Migration: rename apiOrigin → relayOrigin, preserve authApiOrigin → apiOrigin.
    // With defaults removed, this.store.store only contains actually-persisted keys,
    // so key-presence checks are reliable.
    const raw = this.store.store as unknown as Record<string, unknown>;
    const hadRelayOrigin = "relayOrigin" in raw;
    const hadAuthApiOrigin = "authApiOrigin" in raw;
    const oldApiOrigin = raw.apiOrigin as string | undefined;
    const oldAuthApiOrigin = raw.authApiOrigin as string | undefined;

    if (!hadRelayOrigin && typeof oldApiOrigin === "string") {
      // Legacy: apiOrigin held the relay URL. Move it to relayOrigin.
      let relayOrigin = DEFAULT_DESKTOP_SETTINGS.relayOrigin;
      try {
        relayOrigin = normalizeAndValidateOrigin(oldApiOrigin);
      } catch {
        // Fall back to default on invalid value
      }
      this.store.set("relayOrigin" as keyof DesktopSettings, relayOrigin);

      if (hadAuthApiOrigin && typeof oldAuthApiOrigin === "string") {
        // Intermediate build: authApiOrigin held the REST API URL. Promote it.
        let apiOrigin = DEFAULT_DESKTOP_SETTINGS.apiOrigin;
        try {
          apiOrigin = normalizeAndValidateOrigin(oldAuthApiOrigin);
        } catch {
          // Fall back to default on invalid value
        }
        this.store.set("apiOrigin" as keyof DesktopSettings, apiOrigin);
      } else {
        // Pre-auth install: no REST API origin was ever set. Use default.
        this.store.set(
          "apiOrigin" as keyof DesktopSettings,
          DEFAULT_DESKTOP_SETTINGS.apiOrigin
        );
      }
    }

    // Always clean up stale authApiOrigin key (intermediate build artifact).
    if (hadAuthApiOrigin) {
      this.store.delete("authApiOrigin" as keyof DesktopSettings);
    }

    // Migration: replace legacy "auto" tier with "high" (identical behavior).
    if (raw.defaultApprovalTier === "auto") {
      this.store.set("defaultApprovalTier", "high" as RiskTier);
    }
    const rules = raw.autoApprovalRules as Record<string, string> | undefined;
    if (rules) {
      let rulesChanged = false;
      for (const [key, val] of Object.entries(rules)) {
        if (val === "auto") {
          rules[key] = "high";
          rulesChanged = true;
        }
      }
      if (rulesChanged) {
        this.store.set(
          "autoApprovalRules",
          rules as unknown as Record<string, RiskTier>
        );
      }
    }

    // Migration: initialize savedConfigs and activeConfigId for existing installs.
    // TODO(PLN-116-cleanup): Remove this migration block once all existing installs have been upgraded.
    if (!Array.isArray(raw.savedConfigs)) {
      this.store.set("savedConfigs", []);
    }
    if (!("activeConfigId" in raw)) {
      this.store.set(
        "activeConfigId",
        null as DesktopSettings["activeConfigId"]
      );
    }

    this.migrateSavedConfigManagedFields();
  }

  getAll(): DesktopSettings {
    return {
      ...DEFAULT_DESKTOP_SETTINGS,
      ...this.store.store,
      savedConfigs: this.getSavedConfigs(),
    };
  }

  getRelayOrigin(): string {
    return this.store.get("relayOrigin", DEFAULT_DESKTOP_SETTINGS.relayOrigin);
  }

  getApiOrigin(): string {
    return this.store.get("apiOrigin", DEFAULT_DESKTOP_SETTINGS.apiOrigin);
  }

  getWebAppOrigin(): string {
    return this.store.get(
      "webAppOrigin",
      DEFAULT_DESKTOP_SETTINGS.webAppOrigin
    );
  }

  getSandboxBaseDirectory(): string {
    return this.store.get(
      "sandboxBaseDirectory",
      DEFAULT_DESKTOP_SETTINGS.sandboxBaseDirectory
    );
  }

  getOnboardingCompleted(): boolean {
    return this.store.get(
      "onboardingCompleted",
      DEFAULT_DESKTOP_SETTINGS.onboardingCompleted
    );
  }

  getOnboardingPopupDismissedPermanent(): boolean {
    return this.store.get(
      "onboardingPopupDismissedPermanent",
      DEFAULT_DESKTOP_SETTINGS.onboardingPopupDismissedPermanent
    );
  }

  getDashboardWelcomeSeen(): boolean {
    return this.store.get(
      "dashboardWelcomeSeen",
      DEFAULT_DESKTOP_SETTINGS.dashboardWelcomeSeen
    );
  }

  // --- Generic flag accessors (registry-driven) ---

  /**
   * Returns the effective value of a feature flag.
   * Precedence: env override > user-set value > registry default.
   */
  getFlag(key: FlagKey): boolean {
    const def = getFlagDefinition(key);
    if (def.envOverride) {
      const envVal = process.env[def.envOverride];
      if (envVal === "1" || envVal === "true") {
        return true;
      }
      if (envVal === "0" || envVal === "false") {
        return false;
      }
    }
    return this.store.get(key as keyof DesktopSettings, def.default) as boolean;
  }

  setFlag(key: FlagKey, value: boolean): void {
    getFlagDefinition(key); // validate key exists
    this.store.set(key as keyof DesktopSettings, value);
  }

  /** Returns the source of the effective value: env override, user-set, or registry default. */
  getFlagSource(key: FlagKey): "env" | "user" | "default" {
    const def = getFlagDefinition(key);
    if (def.envOverride) {
      const envVal = process.env[def.envOverride];
      if (
        envVal === "1" ||
        envVal === "true" ||
        envVal === "0" ||
        envVal === "false"
      ) {
        return "env";
      }
    }
    const raw = this.store.store as unknown as Record<string, unknown>;
    if (key in raw) {
      return "user";
    }
    return "default";
  }

  /** Returns flag values and sources for all registered flags. */
  getAllFlags(): Array<{
    key: FlagKey;
    value: boolean;
    source: "env" | "user" | "default";
  }> {
    return FEATURE_FLAGS.map((f) => ({
      key: f.key as FlagKey,
      value: this.getFlag(f.key as FlagKey),
      source: this.getFlagSource(f.key as FlagKey),
    }));
  }

  // --- Legacy flag getters (thin wrappers for zero call-site churn) ---
  getCloudCommandsPaused(): boolean {
    return this.getFlag("cloudCommandsPaused");
  }

  getUpdateAndRestartEnabled(): boolean {
    return this.getFlag("updateAndRestartEnabled");
  }

  getCloudConnectionEnabled(): boolean {
    return this.getFlag("cloudConnectionEnabled");
  }

  getAgentMonitorEnabled(): boolean {
    return this.getFlag("agentMonitorEnabled");
  }

  getPlanExtractionEnabled(): boolean {
    return this.getFlag("planExtractionEnabled");
  }

  getCommandSigningEnforcementEnabled(): boolean {
    return this.getFlag("commandSigningEnforcementEnabled");
  }

  getDefaultApprovalTier(): RiskTier {
    return this.store.get(
      "defaultApprovalTier",
      DEFAULT_DESKTOP_SETTINGS.defaultApprovalTier
    );
  }

  setSandboxBaseDirectory(sandboxBaseDirectory: string): void {
    this.store.set("sandboxBaseDirectory", sandboxBaseDirectory);
  }

  setOnboardingCompleted(onboardingCompleted: boolean): void {
    this.store.set("onboardingCompleted", onboardingCompleted);
  }

  setOnboardingPopupDismissedPermanent(
    onboardingPopupDismissedPermanent: boolean
  ): void {
    this.store.set(
      "onboardingPopupDismissedPermanent",
      onboardingPopupDismissedPermanent
    );
  }

  setDashboardWelcomeSeen(dashboardWelcomeSeen: boolean): void {
    this.store.set("dashboardWelcomeSeen", dashboardWelcomeSeen);
  }

  setCloudCommandsPaused(cloudCommandsPaused: boolean): void {
    this.setFlag("cloudCommandsPaused", cloudCommandsPaused);
  }

  setUpdateAndRestartEnabled(updateAndRestartEnabled: boolean): void {
    this.setFlag("updateAndRestartEnabled", updateAndRestartEnabled);
  }

  setCloudConnectionEnabled(cloudConnectionEnabled: boolean): void {
    this.setFlag("cloudConnectionEnabled", cloudConnectionEnabled);
  }

  setAgentMonitorEnabled(agentMonitorEnabled: boolean): void {
    this.setFlag("agentMonitorEnabled", agentMonitorEnabled);
  }

  setPlanExtractionEnabled(planExtractionEnabled: boolean): void {
    this.setFlag("planExtractionEnabled", planExtractionEnabled);
  }

  setCommandSigningEnforcementEnabled(
    commandSigningEnforcementEnabled: boolean
  ): void {
    this.setFlag(
      "commandSigningEnforcementEnabled",
      commandSigningEnforcementEnabled
    );
  }

  setDefaultApprovalTier(defaultApprovalTier: RiskTier): void {
    this.store.set("defaultApprovalTier", defaultApprovalTier);
  }

  setRelayOrigin(relayOrigin: string): void {
    this.store.set("relayOrigin", relayOrigin);
  }

  setApiOrigin(apiOrigin: string): void {
    this.store.set("apiOrigin", apiOrigin);
  }

  setWebAppOrigin(webAppOrigin: string): void {
    this.store.set("webAppOrigin", webAppOrigin);
  }

  setApprovalRule(operationName: string, tier: RiskTier): void {
    const rules = this.store.get(
      "autoApprovalRules",
      DEFAULT_DESKTOP_SETTINGS.autoApprovalRules
    );
    rules[operationName] = tier;
    this.store.set("autoApprovalRules", rules);
  }

  setAutoApprovalRules(autoApprovalRules: Record<string, RiskTier>): void {
    this.store.set("autoApprovalRules", autoApprovalRules);
  }

  setAlwaysAllowRules(alwaysAllowRules: AlwaysAllowRule[]): void {
    this.store.set("alwaysAllowRules", alwaysAllowRules);
  }

  getBinaryPaths(): BinaryPaths {
    return (this.store.get("binaryPaths" as keyof DesktopSettings) ??
      {}) as BinaryPaths;
  }

  patchBinaryPaths(patch: Record<string, string | null>): BinaryPaths {
    const merged: BinaryPaths = { ...this.getBinaryPaths() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete (merged as Record<string, string | undefined>)[key];
      } else {
        (merged as Record<string, string>)[key] = value;
      }
    }
    this.store.set(
      "binaryPaths" as keyof DesktopSettings,
      merged as DesktopSettings["binaryPaths"]
    );
    return merged;
  }

  getSavedConfigs(): SavedConfig[] {
    const rawConfigs = this.store.get(
      "savedConfigs",
      DEFAULT_DESKTOP_SETTINGS.savedConfigs
    ) as unknown;
    if (!Array.isArray(rawConfigs)) {
      this.setSavedConfigs([]);
      return [];
    }
    const configs = rawConfigs.filter(isSavedConfig);
    if (configs.length !== rawConfigs.length) {
      this.setSavedConfigs(configs);
    }
    return configs;
  }

  setSavedConfigs(configs: SavedConfig[]): void {
    this.store.set("savedConfigs", configs);
  }

  getActiveConfigId(): string | null {
    return this.store.get(
      "activeConfigId",
      DEFAULT_DESKTOP_SETTINGS.activeConfigId
    );
  }

  setActiveConfigId(id: string | null): void {
    this.store.set("activeConfigId", id as DesktopSettings["activeConfigId"]);
  }

  getActiveConfig(): SavedConfig | null {
    const activeConfigId = this.getActiveConfigId();
    if (!activeConfigId) {
      return null;
    }
    return this.getSavedConfigs().find((c) => c.id === activeConfigId) ?? null;
  }

  private validateConfigName(name: string): string {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) {
      throw new Error("Config name is required");
    }
    if (trimmed.length > 200) {
      throw new Error("Config name must be 200 characters or fewer");
    }
    return trimmed;
  }

  private assertNameAvailable(
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

  findConfigByOrigins(
    relayOrigin: string,
    apiOrigin: string,
    webAppOrigin: string
  ): SavedConfig | null {
    const configs = this.getSavedConfigs();
    return (
      configs.find(
        (c) =>
          c.relayOrigin === relayOrigin &&
          c.apiOrigin === apiOrigin &&
          c.webAppOrigin === webAppOrigin
      ) ?? null
    );
  }

  private getAvailableConfigName(preferredName: string): string {
    const baseName = this.validateConfigName(preferredName);
    const usedNames = new Set(
      this.getSavedConfigs().map((config) =>
        config.name.trim().toLocaleLowerCase()
      )
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
   * Ensures the current runtime origins are represented by an active saved
   * profile, reusing a matching profile before creating a default one.
   */
  ensureActiveConfigForCurrentOrigins(
    preferredName = DEFAULT_MANAGED_ONBOARDING_CONFIG_NAME
  ): SavedConfig {
    const relayOrigin = this.getRelayOrigin();
    const apiOrigin = this.getApiOrigin();
    const webAppOrigin = this.getWebAppOrigin();

    const activeConfig = this.getActiveConfig();
    if (activeConfig) {
      return (
        this.updateActiveConfigOrigins({
          relayOrigin,
          apiOrigin,
          webAppOrigin,
        }) ?? activeConfig
      );
    }

    const matchingConfig = this.findConfigByOrigins(
      relayOrigin,
      apiOrigin,
      webAppOrigin
    );
    if (matchingConfig) {
      return this.applyConfig(matchingConfig.id);
    }

    const savedConfig = this.saveConfig(
      this.getAvailableConfigName(preferredName)
    );
    return this.applyConfig(savedConfig.id);
  }

  saveConfig(name: string, options?: SaveConfigOptions): SavedConfig {
    const trimmedName = this.validateConfigName(name);
    const configs = this.getSavedConfigs();
    this.assertNameAvailable(configs, trimmedName);
    const config: SavedConfig = {
      id: randomUUID(),
      name: trimmedName,
      relayOrigin:
        options?.relayOrigin === undefined
          ? this.getRelayOrigin()
          : normalizeAndValidateOrigin(options.relayOrigin),
      apiOrigin:
        options?.apiOrigin === undefined
          ? this.getApiOrigin()
          : normalizeAndValidateOrigin(options.apiOrigin),
      webAppOrigin:
        options?.webAppOrigin === undefined
          ? this.getWebAppOrigin()
          : normalizeWebAppOrigin(options.webAppOrigin),
      apiKeySource: "USER_CREATED",
      gatewayPort: options?.gatewayPort ?? null,
      computeTarget: options?.computeTarget ?? null,
    };
    configs.push(config);
    this.setSavedConfigs(configs);
    return config;
  }

  listConfigs(): SavedConfig[] {
    return this.getSavedConfigs();
  }

  deleteConfig(id: string): { wasActive: boolean } {
    const configs = this.getSavedConfigs();
    const index = configs.findIndex((c) => c.id === id);
    if (index === -1) {
      return { wasActive: false };
    }
    const activeConfigId = this.getActiveConfigId();
    const wasActive = activeConfigId === id;
    configs.splice(index, 1);
    this.setSavedConfigs(configs);
    if (wasActive) {
      this.setActiveConfigId(null);
    }
    return { wasActive };
  }

  /**
   * Returns whether a gateway identity is still referenced by any saved profile
   * or by the active unsaved legacy runtime identity.
   */
  isGatewayIdReferenced(
    gatewayId: string | null | undefined,
    options: { activeRuntimeGatewayId?: string | null } = {}
  ): boolean {
    const normalizedGatewayId = gatewayId?.trim();
    if (!normalizedGatewayId) {
      return false;
    }
    if (options.activeRuntimeGatewayId?.trim() === normalizedGatewayId) {
      return true;
    }
    return this.getSavedConfigs().some(
      (config) => config.gatewayId?.trim() === normalizedGatewayId
    );
  }

  renameConfig(id: string, name: string): void {
    const trimmedName = this.validateConfigName(name);
    const configs = this.getSavedConfigs();
    const index = configs.findIndex((c) => c.id === id);
    if (index === -1) {
      throw new Error(`Config not found: ${id}`);
    }
    this.assertNameAvailable(configs, trimmedName, id);
    configs[index] = { ...configs[index], name: trimmedName };
    this.setSavedConfigs(configs);
  }

  updateConfigConnection(
    id: string,
    patch: SavedConfigConnectionPatch
  ): SavedConfig {
    const configs = this.getSavedConfigs();
    const index = configs.findIndex((c) => c.id === id);
    if (index === -1) {
      throw new Error(`Config not found: ${id}`);
    }
    const updates: Partial<SavedConfig> = {};
    if (patch.name !== undefined) {
      const trimmedName = this.validateConfigName(patch.name);
      this.assertNameAvailable(configs, trimmedName, id);
      updates.name = trimmedName;
    }
    if (patch.relayOrigin !== undefined) {
      updates.relayOrigin = normalizeAndValidateOrigin(patch.relayOrigin);
    }
    if (patch.apiOrigin !== undefined) {
      updates.apiOrigin = normalizeAndValidateOrigin(patch.apiOrigin);
    }
    if (patch.webAppOrigin !== undefined) {
      updates.webAppOrigin = normalizeWebAppOrigin(patch.webAppOrigin);
    }
    if (patch.gatewayPort !== undefined) {
      updates.gatewayPort = patch.gatewayPort;
    }
    if (patch.computeTarget !== undefined) {
      updates.computeTarget = patch.computeTarget;
    }
    configs[index] = { ...configs[index], ...updates };
    this.setSavedConfigs(configs);
    return configs[index];
  }

  applyConfig(id: string): SavedConfig {
    const configs = this.getSavedConfigs();
    const config = configs.find((c) => c.id === id);
    if (!config) {
      throw new Error(`Config not found: ${id}`);
    }
    const normalizedRelayOrigin = normalizeAndValidateOrigin(
      config.relayOrigin
    );
    const normalizedApiOrigin = normalizeAndValidateOrigin(config.apiOrigin);
    const normalizedWebAppOrigin = normalizeWebAppOrigin(config.webAppOrigin);
    this.setRelayOrigin(normalizedRelayOrigin);
    this.setApiOrigin(normalizedApiOrigin);
    this.setWebAppOrigin(normalizedWebAppOrigin);
    this.setActiveConfigId(id);
    return config;
  }

  /**
   * Ensures the saved profile has its own stable gateway UUID, creating it only
   * for that profile. Unsaved legacy installs continue using the legacy identity.
   */
  ensureConfigGatewayId(id: string): SavedConfig {
    const configs = this.getSavedConfigs();
    const index = configs.findIndex((c) => c.id === id);
    if (index === -1) {
      throw new Error(`Config not found: ${id}`);
    }
    const existing = configs[index].gatewayId;
    if (existing && UUID_V4_RE.test(existing)) {
      return configs[index];
    }
    configs[index] = {
      ...configs[index],
      gatewayId: randomUUID(),
      desktopSecurityUpgradeProtocolVersion: 1,
    };
    this.setSavedConfigs(configs);
    return configs[index];
  }

  /** Updates non-secret managed-key metadata for a saved profile. */
  updateConfigManagedMetadata(
    id: string,
    patch: SavedConfigManagedPatch
  ): SavedConfig {
    const configs = this.getSavedConfigs();
    const index = configs.findIndex((c) => c.id === id);
    if (index === -1) {
      throw new Error(`Config not found: ${id}`);
    }
    const hasChanges = Object.entries(patch).some(([key, value]) => {
      const field = key as keyof SavedConfig;
      return configs[index][field] !== value;
    });
    if (!hasChanges) {
      return configs[index];
    }
    configs[index] = {
      ...configs[index],
      ...patch,
    };
    this.setSavedConfigs(configs);
    return configs[index];
  }

  /** Updates managed-key metadata for the active saved profile when one exists. */
  updateActiveConfigManagedMetadata(
    patch: SavedConfigManagedPatch
  ): SavedConfig | null {
    const activeConfigId = this.getActiveConfigId();
    if (!activeConfigId) {
      return null;
    }
    return this.updateConfigManagedMetadata(activeConfigId, patch);
  }

  /** Updates trusted origins for the active saved profile when one exists. */
  updateActiveConfigOrigins(
    patch: SavedConfigOriginsPatch
  ): SavedConfig | null {
    const activeConfigId = this.getActiveConfigId();
    if (!activeConfigId) {
      return null;
    }
    const configs = this.getSavedConfigs();
    const index = configs.findIndex((c) => c.id === activeConfigId);
    if (index === -1) {
      throw new Error(`Config not found: ${activeConfigId}`);
    }
    configs[index] = {
      ...configs[index],
      relayOrigin: normalizeAndValidateOrigin(patch.relayOrigin),
      apiOrigin: normalizeAndValidateOrigin(patch.apiOrigin),
      webAppOrigin: normalizeWebAppOrigin(patch.webAppOrigin),
    };
    this.setSavedConfigs(configs);
    return configs[index];
  }

  update(partial: Partial<DesktopSettings>): DesktopSettings {
    if (typeof partial.sandboxBaseDirectory === "string") {
      this.store.set("sandboxBaseDirectory", partial.sandboxBaseDirectory);
    }
    if (typeof partial.onboardingCompleted === "boolean") {
      this.store.set("onboardingCompleted", partial.onboardingCompleted);
    }
    if (typeof partial.onboardingPopupDismissedPermanent === "boolean") {
      this.store.set(
        "onboardingPopupDismissedPermanent",
        partial.onboardingPopupDismissedPermanent
      );
    }
    // Handle all registered feature flags generically.
    for (const key of FLAG_KEYS) {
      const val = (partial as Record<string, unknown>)[key];
      if (typeof val === "boolean") {
        this.setFlag(key as FlagKey, val);
      }
    }
    if (typeof partial.verboseLogging === "boolean") {
      this.store.set("verboseLogging", partial.verboseLogging);
    }
    if (typeof partial.relayOrigin === "string") {
      this.store.set("relayOrigin", partial.relayOrigin);
    }
    if (typeof partial.apiOrigin === "string") {
      this.store.set("apiOrigin", partial.apiOrigin);
    }
    if (typeof partial.webAppOrigin === "string") {
      this.store.set("webAppOrigin", partial.webAppOrigin);
    }
    if (partial.autoApprovalRules) {
      this.store.set("autoApprovalRules", partial.autoApprovalRules);
    }
    if (partial.alwaysAllowRules) {
      this.store.set("alwaysAllowRules", partial.alwaysAllowRules);
    }
    if (partial.defaultApprovalTier) {
      this.store.set("defaultApprovalTier", partial.defaultApprovalTier);
    }
    return this.getAll();
  }

  // --- Managed-key hint getters/setters (D5 / AC-010) ---

  getManagedKeyHintDismissedAt(): string | null {
    return this.store.get("managedKeyHintDismissedAt", null);
  }

  setManagedKeyHintDismissedAt(value: string | null): void {
    this.store.set("managedKeyHintDismissedAt", value);
  }

  getManagedKeyHintLastSeenProvenance():
    | "DESKTOP_MANAGED"
    | "USER_CREATED"
    | null {
    return this.store.get("managedKeyHintLastSeenProvenance", null);
  }

  setManagedKeyHintLastSeenProvenance(
    value: "DESKTOP_MANAGED" | "USER_CREATED" | null
  ): void {
    this.store.set("managedKeyHintLastSeenProvenance", value);
  }

  private migrateSavedConfigManagedFields(): void {
    const configs = this.getSavedConfigs();
    let changed = false;
    const migrated = configs.map((config) => {
      const hasManagedIdentity =
        typeof config.gatewayId === "string" &&
        UUID_V4_RE.test(config.gatewayId) &&
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

    if (changed) {
      this.setSavedConfigs(migrated);
    }
  }
}
