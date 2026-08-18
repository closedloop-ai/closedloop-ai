import { randomUUID } from "node:crypto";
import Store from "electron-store";
import {
  type AlwaysAllowRule,
  type DataSyncLevel,
  DEFAULT_DESKTOP_SETTINGS,
  type DeclinedDistributionRecord,
  type DesktopSettings,
  type RiskTier,
  type SavedConfig,
  type SyncObservabilityTier,
} from "../../shared/contracts.js";
import {
  coercePersistedDataSyncLevel,
  DEFAULT_DATA_SYNC_LEVEL,
  dataSyncLevelToBooleans,
  reconcileDataSyncLevel,
} from "../../shared/data-sync-level.js";
import {
  FEATURE_FLAGS,
  FLAG_KEYS,
  type FlagKey,
  getFlagDefinition,
} from "../../shared/feature-flags.js";
import {
  normalizeScopePath,
  validateSandboxBaseDirectory,
} from "../../shared/sandbox-policy.js";
import type { SyncConsentRecord } from "../../shared/sync-consent.js";
import { type BinaryPaths, mergeBinaryPaths } from "./binary-paths.js";
import {
  normalizeAndValidateOrigin,
  normalizeWebAppOrigin,
} from "./origin-policy.js";
import {
  assertNameAvailable,
  DEFAULT_MANAGED_ONBOARDING_CONFIG_NAME,
  getAvailableConfigName,
  isSavedConfig,
  isUuidV4,
  type SaveConfigOptions,
  type SavedConfigConnectionPatch,
  type SavedConfigManagedPatch,
  type SavedConfigOriginsPatch,
  sanitizeSavedConfig,
  validateConfigName,
} from "./saved-config.js";
import { runSettingsMigrations } from "./settings-migrations.js";

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

    // One-time, boot-time store reconciliation (legacy-key cleanup, origin
    // rename, approval-tier rewrite, saved-config init, FEA-3462 sync-consent
    // floor, FEA-3907 data-sync-level backfill, managed-key reconcile). Each
    // block is idempotent and guarded on the legacy state it reconciles. Lives
    // in `settings-migrations.ts` so this file stays under the 1,000-line
    // ceiling; `this` satisfies `SettingsMigrationTarget` structurally.
    runSettingsMigrations(this);
  }

  /**
   * The raw persisted electron-store, exposed for {@link runSettingsMigrations}
   * (which needs typed get/set/delete + key-presence checks on the backing
   * store). Not part of the public store API — callers use the typed accessors.
   */
  get rawStore(): Store<DesktopSettings> & {
    readonly store: Record<string, unknown>;
  } {
    return this.store as Store<DesktopSettings> & {
      readonly store: Record<string, unknown>;
    };
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
    // PRD-566 / FEA-4348: `routines` (renamed from `scheduledTasks`) dual-writes
    // its legacy shadow so the rename is not a one-way door — a downgrade to a
    // pre-rename build still reads the current value instead of defaulting the
    // scheduler off. See `migrateScheduledTasksToRoutines`. Retire with the
    // shadow once all installs are past the rename (Compatibility Guardrail).
    if (key === "routines") {
      this.store.set("scheduledTasks" as keyof DesktopSettings, value);
    }
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

  getPlanExtractionEnabled(): boolean {
    return this.getFlag("planExtractionEnabled");
  }

  /**
   * FEA-3741 (slice 1): the per-tool collector enable snapshot for the three
   * harnesses that own an on/off toggle (Claude/Cursor/Copilot — the collectors
   * whose tool-home walk can incidentally touch a TCC-protected folder). Default
   * ON via the registry. Consumed by the Agent Dashboard runtime as its
   * `getCollectorEnabledState`; a `false` entry both routes the harness to
   * `"disabled"` mode and skips its historical/tool-home import entirely. Only
   * enumerating the toggled harnesses (not Codex/OpenCode) is intentional —
   * `CollectorEnabledState` is a partial record and omission means "enabled".
   */
  getCollectorEnabledState(): {
    claude: boolean;
    cursor: boolean;
    copilot: boolean;
  } {
    return {
      claude: this.getFlag("collectClaudeEnabled"),
      cursor: this.getFlag("collectCursorEnabled"),
      copilot: this.getFlag("collectCopilotEnabled"),
    };
  }

  getCommandSigningEnforcementEnabled(): boolean {
    return this.getFlag("commandSigningEnforcementEnabled");
  }

  getLoopCompletedNotificationsEnabled(): boolean {
    return this.getFlag("loopCompletedNotificationsEnabled");
  }

  getTranscriptSyncEnabled(): boolean {
    return this.getFlag("transcriptSyncEnabled");
  }

  /**
   * PRD-532 §7 — the user's chosen sync-observability tier, or `null` if they
   * have not consented yet (nothing syncs by default).
   */
  getSyncObservabilityTier(): SyncObservabilityTier | null {
    return this.store.get(
      "syncObservabilityTier",
      DEFAULT_DESKTOP_SETTINGS.syncObservabilityTier
    );
  }

  setSyncObservabilityTier(tier: SyncObservabilityTier): void {
    this.store.set("syncObservabilityTier", tier);
  }

  /**
   * ISS-5489 — the org the recorded sync consent belongs to, or `null` when the
   * consent predates the binding (or was recorded with no org). Read alongside
   * {@link getSyncObservabilityTier} to decide whether the post-auth consent
   * takeover has already been answered for the signed-in org.
   */
  getSyncConsentOrganizationId(): string | null {
    return this.store.get(
      "syncConsentOrganizationId",
      DEFAULT_DESKTOP_SETTINGS.syncConsentOrganizationId
    );
  }

  /**
   * ISS-5489 — whether an org binding was ever written, as opposed to absent.
   *
   * `getSyncConsentOrganizationId` cannot answer this: it returns `null` both for
   * a key that has never existed (a pre-ISS-5489 install) and for one
   * deliberately set to `null` (a user with no org). Only key PRESENCE separates
   * them, and the difference decides whether an org switch re-prompts.
   */
  hasSyncConsentOrganizationBinding(): boolean {
    return this.store.has("syncConsentOrganizationId");
  }

  setSyncConsentOrganizationId(organizationId: string | null): void {
    this.store.set("syncConsentOrganizationId", organizationId);
  }

  /**
   * ISS-5489 — the three consent fields as ONE record, because every consumer
   * needs all three to answer anything: the tier alone cannot say whether the
   * answer covers the org that is signed in now. Read by the post-auth takeover
   * (over IPC) and by the main-process egress gate.
   */
  getSyncConsentRecord(): SyncConsentRecord {
    return {
      tier: this.getSyncObservabilityTier(),
      organizationId: this.getSyncConsentOrganizationId(),
      bound: this.hasSyncConsentOrganizationBinding(),
    };
  }

  /**
   * ISS-5489 — drop the recorded answer, returning this device to the
   * not-yet-consented state. Used when re-binding consent to a DIFFERENT org, so
   * the previous org's tier cannot survive into the new binding.
   */
  clearSyncObservabilityTier(): void {
    this.store.set("syncObservabilityTier", null);
  }

  /**
   * FEA-3907 — the graduated data sync level for the "Data & Sync" control.
   * Returns the recommended default when unset rather than `null`. The persisted
   * level is reconciled against the live flags so an out-of-band Relay/Gateway
   * toggle can never leave the tab showing a stale level (see
   * {@link reconcileDataSyncLevel}).
   */
  getDataSyncLevel(): DataSyncLevel {
    const liveFlags = {
      cloudConnectionEnabled: this.getFlag("cloudConnectionEnabled"),
      transcriptSyncEnabled: this.getFlag("transcriptSyncEnabled"),
      syncObservabilityTier: this.getSyncObservabilityTier(),
    };
    // The store value is untrusted disk data: a downgrade from a newer Desktop
    // build (which persisted a level this build doesn't know) leaves an
    // out-of-contract string that the one-time migration skipped (it fired for a
    // NEWER install). Coerce an unknown value to the safe legacy derivation from
    // the live flags instead of feeding it into `reconcileDataSyncLevel` →
    // `dataSyncLevelToBooleans`, whose exhaustiveness guard would throw.
    const persisted = coercePersistedDataSyncLevel(
      this.store.get("dataSyncLevel", DEFAULT_DATA_SYNC_LEVEL),
      liveFlags
    );
    return reconcileDataSyncLevel(persisted, liveFlags);
  }

  /**
   * FEA-3907 — persist the data sync level and derive its connectivity/sync
   * booleans in the same write, so the level and the individual flags every
   * runtime consumer reads can never drift out of agreement. This is the ONLY
   * sanctioned way to change `cloudConnectionEnabled` / `cloudCommandsPaused` /
   * `transcriptSyncEnabled` / `syncObservabilityTier` as a group; the legacy
   * per-flag setters remain for the Relay/Gateway operational controls.
   */
  setDataSyncLevel(level: DataSyncLevel): void {
    const derived = dataSyncLevelToBooleans(level);
    // Validate the flag keys exist before writing (mirrors `setFlag`), then write
    // the level and all four derived values in ONE atomic `set(object)` call.
    // electron-store persists the whole config file per `set`, so a single object
    // write can never be torn between keys — a crash mid-write leaves either the
    // whole old state or the whole new state, never a Full-level with Off flags
    // (which a fresh boot would treat as authoritative and skip migration on).
    getFlagDefinition("cloudConnectionEnabled");
    getFlagDefinition("cloudCommandsPaused");
    getFlagDefinition("transcriptSyncEnabled");
    this.store.set({
      dataSyncLevel: level,
      cloudConnectionEnabled: derived.cloudConnectionEnabled,
      cloudCommandsPaused: derived.cloudCommandsPaused,
      transcriptSyncEnabled: derived.transcriptSyncEnabled,
      syncObservabilityTier: derived.syncObservabilityTier,
    } as Partial<DesktopSettings>);
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
    const merged = mergeBinaryPaths(this.getBinaryPaths(), patch);
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
    const validConfigs = rawConfigs.filter(isSavedConfig);
    const configs = validConfigs.map(sanitizeSavedConfig);
    // Persist back when invalid entries were filtered out, or when sanitizing
    // dropped a malformed `sandboxBaseDirectory` (same length, changed content).
    const droppedInvalid = validConfigs.length !== rawConfigs.length;
    const sanitizedAny = configs.some(
      (config, index) => config !== validConfigs[index]
    );
    if (droppedInvalid || sanitizedAny) {
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
      // Origin reconciliation only — do not let a reused profile's sandbox
      // override the current (possibly just-set) global sandbox (FEA-4005).
      return this.applyConfig(matchingConfig.id, { applySandbox: false });
    }

    const savedConfig = this.saveConfig(
      getAvailableConfigName(this.getSavedConfigs(), preferredName)
    );
    return this.applyConfig(savedConfig.id, { applySandbox: false });
  }

  saveConfig(name: string, options?: SaveConfigOptions): SavedConfig {
    const trimmedName = validateConfigName(name);
    const configs = this.getSavedConfigs();
    assertNameAvailable(configs, trimmedName);
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
      // FEA-4005: persist the per-profile sandbox only when provided, so older
      // profiles / callers that omit it fall back to the global sandbox on apply.
      ...(options?.sandboxBaseDirectory === undefined
        ? {}
        : {
            sandboxBaseDirectory: validateSandboxBaseDirectory(
              options.sandboxBaseDirectory
            ),
          }),
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
    const trimmedName = validateConfigName(name);
    const configs = this.getSavedConfigs();
    const index = configs.findIndex((c) => c.id === id);
    if (index === -1) {
      throw new Error(`Config not found: ${id}`);
    }
    assertNameAvailable(configs, trimmedName, id);
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
      const trimmedName = validateConfigName(patch.name);
      assertNameAvailable(configs, trimmedName, id);
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
    // FEA-4005: normalize + guard the per-profile sandbox at this edit point too
    // (same FEA-3641 risky-root rejection as onboarding/global settings). Only
    // touch the field when the caller supplied it, preserving omission.
    if (patch.sandboxBaseDirectory !== undefined) {
      updates.sandboxBaseDirectory = validateSandboxBaseDirectory(
        patch.sandboxBaseDirectory
      );
    }
    configs[index] = { ...configs[index], ...updates };
    this.setSavedConfigs(configs);
    return configs[index];
  }

  applyConfig(id: string, options?: { applySandbox?: boolean }): SavedConfig {
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
    // FEA-4005: apply this profile's sandbox scope root when it carries one, but
    // only for a user-facing activate (default). Origin-reconciliation callers
    // (`ensureActiveConfigForCurrentOrigins`) pass `applySandbox: false` so a
    // reused profile's stale sandbox never clobbers a just-set global sandbox
    // (e.g. the one managed onboarding just persisted). Profiles persisted
    // before this field existed omit it and keep the current global sandbox
    // (graceful degradation for version skew). Gate on a normalized value rather
    // than `!== undefined` so a blank/whitespace persisted sandbox that slipped
    // past load-time sanitization degrades to the global sandbox instead of
    // throwing SANDBOX_REQUIRED mid-apply after the origins already changed.
    if (
      options?.applySandbox !== false &&
      normalizeScopePath(config.sandboxBaseDirectory)
    ) {
      this.setSandboxBaseDirectory(
        validateSandboxBaseDirectory(config.sandboxBaseDirectory)
      );
    }
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
    if (existing && isUuidV4(existing)) {
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
    // Handle all registered feature flags generically. `verboseLogging` is a
    // registered flag (see feature-flags.ts), so it is persisted by this loop.
    for (const key of FLAG_KEYS) {
      const val = (partial as Record<string, unknown>)[key];
      if (typeof val === "boolean") {
        this.setFlag(key as FlagKey, val);
      }
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
    // `syncObservabilityTier` is nullable ("has not consented yet"), so accept
    // an explicit `null` here as well as a tier string — the renderer's
    // desktopApi.updateSettings(...) path is the only way the SyncConsent UI
    // persists the choice.
    if (
      partial.syncObservabilityTier === null ||
      typeof partial.syncObservabilityTier === "string"
    ) {
      this.store.set("syncObservabilityTier", partial.syncObservabilityTier);
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

  /**
   * FEA-4050: all opt-in distributions the user has declined/dismissed. Read on
   * each reconcile to suppress an already-declined pack and on banner mount to
   * seed the in-memory handled set. Merges the persisted list over the default
   * so a store written before this field exists reads as an empty list.
   */
  getDeclinedDistributions(): DeclinedDistributionRecord[] {
    return (
      this.store.get(
        "declinedDistributions",
        DEFAULT_DESKTOP_SETTINGS.declinedDistributions
      ) ?? []
    );
  }

  /**
   * FEA-4050: has the user declined this distribution (by assignment id) for the
   * given compute target?
   *
   * Scoped by `computeTargetId` so a decline recorded under one user/profile
   * does not suppress the same org distribution for a different user/profile
   * after an account switch. A stored record with NO `computeTargetId` (written
   * before that field existed, or an offline id-only decline whose compute
   * target was unknown) matches ANY compute target — preserving the prior
   * installation-global behavior for legacy records and never losing a decline.
   * When the caller has no compute target (offline), only such
   * unscoped/matching records can suppress.
   */
  isDistributionDeclined(
    distributionId: string,
    computeTargetId?: string
  ): boolean {
    return this.getDeclinedDistributions().some(
      (record) =>
        record.distributionId === distributionId &&
        distributionDeclineScopeMatches(record, computeTargetId)
    );
  }

  /**
   * FEA-4050: durably record a decline of an org-distributed opt-in pack.
   *
   * Upsert-by-(`distributionId`, `computeTargetId`): a repeated decline of the
   * same distribution for the same compute target refreshes the existing record
   * in place (no duplicate rows, `declinedAt` updated) rather than appending.
   * Declines of the same distribution under DIFFERENT compute targets are kept
   * as separate records so each user/profile's decision stands alone. Keyed on
   * the assignment-level id — the same dimension the reconcile filters on — so a
   * genuinely-new re-share (a new `distributionId`) is never suppressed by an
   * older decline. `declinedAt` defaults to now (ISO-8601 UTC).
   */
  recordDeclinedDistribution(
    record: Omit<DeclinedDistributionRecord, "declinedAt"> & {
      declinedAt?: string;
    }
  ): void {
    const declinedAt = record.declinedAt ?? new Date().toISOString();
    const next: DeclinedDistributionRecord = {
      distributionId: record.distributionId,
      catalogItemId: record.catalogItemId,
      organizationId: record.organizationId,
      declinedAt,
    };
    // Preserve omission of the optional compute-target scope (version-skew
    // safe): only serialize it when a value is actually present.
    if (record.computeTargetId) {
      next.computeTargetId = record.computeTargetId;
    }
    const existing = this.getDeclinedDistributions().filter(
      (r) =>
        r.distributionId !== next.distributionId ||
        r.computeTargetId !== next.computeTargetId
    );
    existing.push(next);
    this.store.set("declinedDistributions", existing);
  }
}

/**
 * FEA-4050: does a stored decline record apply to the given compute target?
 *
 * A record with no `computeTargetId` (legacy pre-scope records, or an offline
 * id-only decline) is treated as installation-global and matches any compute
 * target — this preserves existing declines on upgrade and never loses one.
 * A scoped record matches only its own compute target. When the caller has no
 * compute target (offline check), only unscoped records can match.
 */
function distributionDeclineScopeMatches(
  record: DeclinedDistributionRecord,
  computeTargetId?: string
): boolean {
  if (!record.computeTargetId) {
    return true;
  }
  return record.computeTargetId === computeTargetId;
}
