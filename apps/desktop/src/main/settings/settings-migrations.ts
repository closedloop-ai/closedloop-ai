import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { RECOMMENDED_DATA_SYNC_LEVEL } from "@repo/api/src/types/data-sync-level";
import type {
  DesktopSettings,
  RiskTier,
  SavedConfig,
  SyncObservabilityTier,
} from "../../shared/contracts.js";
import { DEFAULT_DESKTOP_SETTINGS } from "../../shared/contracts.js";
import type { LegacyDataSyncFlags } from "../../shared/data-sync-level.js";
import {
  dataSyncLevelToBooleans,
  legacyFlagsToDataSyncLevel,
} from "../../shared/data-sync-level.js";
import type { FlagKey } from "../../shared/feature-flags.js";
import { RETIRED_LABS_SETTING_KEYS } from "./labs-setting-key-ledger.js";
import { normalizeAndValidateOrigin } from "./origin-policy.js";
import { reconcileManagedApiKeySources } from "./saved-config.js";

/**
 * One-time, boot-time store reconciliation for `SettingsStore`, split out of
 * `settings-store.ts` (FEA-3907) so that file stays under the 1,000-line
 * ceiling. Every function here is an idempotent migration that upgrades a
 * persisted store forward without escalating exposure — the legacy-key cleanup
 * blocks, the origin rename, the approval-tier rewrite, the saved-config init,
 * the FEA-3462 sync-consent floor, the FEA-3907 data-sync-level backfill, and
 * the managed-key metadata reconcile.
 *
 * They operate on the raw persisted store plus the flag/config accessors the
 * class already exposes, passed as {@link SettingsMigrationTarget}, so the
 * migrations stay behavior-identical to when they lived inline in the
 * constructor and can be unit-tested against a real `SettingsStore` instance.
 *
 * `migrateDataSyncLevel` preserves effective connectivity separately from the
 * explicit consent answer; a missing answer remains unset (ISS-12523).
 */

/**
 * The narrow slice of `SettingsStore` the boot migrations depend on. Kept
 * explicit so a migration can only reach the store surface it needs and so the
 * class satisfies it structurally by passing `this`.
 */
export type SettingsMigrationTarget = {
  /** The raw persisted store — key presence + typed get/set/delete. */
  readonly rawStore: {
    readonly store: Record<string, unknown>;
    get<Key extends keyof DesktopSettings>(
      key: Key,
      defaultValue?: DesktopSettings[Key]
    ): DesktopSettings[Key];
    set<Key extends keyof DesktopSettings>(
      key: Key,
      value: DesktopSettings[Key]
    ): void;
    set(values: Partial<DesktopSettings>): void;
    delete(key: keyof DesktopSettings): void;
  };
  getFlag(key: FlagKey): boolean;
  setFlag(key: FlagKey, value: boolean): void;
  getFlagSource(key: FlagKey): "env" | "user" | "default";
  getSyncObservabilityTier(): SyncObservabilityTier | null;
  getSavedConfigs(): SavedConfig[];
  setSavedConfigs(configs: SavedConfig[]): void;
};

/**
 * Runs every boot-time store migration in the order the constructor previously
 * ran them. Safe to call on every launch: each block is guarded on the presence
 * of the legacy state it reconciles.
 */
export function runSettingsMigrations(target: SettingsMigrationTarget): void {
  const store = target.rawStore;
  // ISS-10554 — detected AND acted on before any other migration runs, because
  // several of them write unconditionally on a first launch (`removeRetiredKeys`
  // seeds `agentCollaborationNetworkResidueCleared`). Both halves have to be up
  // here. Detecting late would misread a never-booted store as an existing one;
  // detecting early and SEEDING late leaves a crash window in between, and a
  // process that dies in it boots next time into a store that is no longer empty,
  // so the seed never runs again and the install silently reconciles down to the
  // metadata floor — the new-install default lost permanently, to a crash. The
  // seed is one store write, so it either lands whole or not at all; anything that
  // crashes after it finds a settled level on the next boot and reconciles it
  // normally.
  const firstLaunch = Object.keys(store.store).length === 0;
  if (firstLaunch) {
    seedRecommendedDataSyncLevel(target, RECOMMENDED_DATA_SYNC_LEVEL);
  }
  removeRetiredKeys(store);
  removeRetiredScheduledTasksShadow(store);

  const raw = store.store;
  migrateOriginRename(store, raw);
  migrateApprovalTier(store, raw);
  migrateAlwaysAllowRulesContainer(store, raw);
  migrateSavedConfigsInit(store, raw);
  migrateSavedConfigManagedFields(target);
  // Reconciles BOTH the data-sync level and the stranded sync-consent tier
  // (formerly `migrateStrandedSyncConsent`, FEA-3462) in one pass.
  migrateDataSyncLevel(target, raw, firstLaunch);
}

/**
 * Deletes stale/retired keys from previous versions. electron-store spreads raw
 * persisted data in getAll(), so a stale key would bleed through to IPC
 * responses even after removing it from the type.
 */
function removeRetiredKeys(store: SettingsMigrationTarget["rawStore"]): void {
  // Migration: delete stale allowedDirectories key from previous versions.
  if ("allowedDirectories" in store.store) {
    store.delete("allowedDirectories" as keyof DesktopSettings);
  }
  // TODO(FEA-1550): remove these migration blocks once all installs have upgraded past 0.16.0
  if ("agentDashboardDesignSystemEnabled" in store.store) {
    store.delete("agentDashboardDesignSystemEnabled" as keyof DesktopSettings);
  }
  if ("agentSessionChunkedSyncEnabled" in store.store) {
    store.delete("agentSessionChunkedSyncEnabled" as keyof DesktopSettings);
  }
  // FEA-2503: the Agent Dashboard is now always on and its toggle has been
  // removed. Delete any persisted `agentMonitorEnabled` value so a legacy
  // stored `false` (from a user who had turned it off) can never hide the
  // dashboard — electron-store spreads raw persisted data in getAll(), so a
  // stale key would otherwise bleed through to IPC responses.
  if ("agentMonitorEnabled" in store.store) {
    store.delete("agentMonitorEnabled" as keyof DesktopSettings);
  }
  // TODO(PLN-1138-cleanup): remove once all installs have upgraded past the
  // read-source-indicator retirement. The Labs toggle became always-on, so a
  // persisted value must be cleared or it would bleed through getAll().
  if ("read-source-indicator" in store.store) {
    store.delete("read-source-indicator" as keyof DesktopSettings);
  }
  // FEA-3993: the Codex Runtime Metadata rows graduated out of Labs and render
  // for everyone (self-gating on presence), so the toggle was removed from the
  // registry. An existing install that opted the Labs flag on (or off) still
  // carries the persisted `sessions-codex-runtime-metadata` key; electron-store
  // spreads raw persisted data in getAll(), so it would bleed through to IPC
  // responses. Delete it here so the graduated key leaves no residue.
  if ("sessions-codex-runtime-metadata" in store.store) {
    store.delete("sessions-codex-runtime-metadata" as keyof DesktopSettings);
  }
  // FEA-3994: the Agents Workspace graduated out of Labs and is always-on, so
  // its `agents` toggle was removed from the registry. An existing install that
  // opted the Labs flag on (or off) still carries the persisted `agents` key;
  // electron-store spreads raw persisted data in getAll(), so it would bleed
  // through to IPC responses. Delete it here so the graduated key leaves no
  // residue.
  if ("agents" in store.store) {
    store.delete("agents" as keyof DesktopSettings);
  }
  // FEA-3995: Tools, MCPs & Hooks in Agents graduated out of Labs and render
  // for everyone (the shared `AgentsGroupedList` no longer gates on it), so its
  // `agents-show-tools-mcps-hooks` toggle was removed from the registry. An
  // existing install that opted the Labs flag on (or off) still carries the
  // persisted key; electron-store spreads raw persisted data in getAll(), so it
  // would bleed through to IPC responses. Delete it here so the graduated key
  // leaves no residue.
  if ("agents-show-tools-mcps-hooks" in store.store) {
    store.delete("agents-show-tools-mcps-hooks" as keyof DesktopSettings);
  }
  // FEA-4000: the AI Impact card graduated out of Labs and renders for everyone,
  // so its `aiImpactCardEnabled` toggle was removed from the registry. An
  // existing install that opted the Labs flag on (or off) still carries the
  // persisted key; electron-store spreads raw persisted data in getAll(), so it
  // would bleed through to IPC responses. Delete it here so the graduated key
  // leaves no residue.
  if ("aiImpactCardEnabled" in store.store) {
    store.delete("aiImpactCardEnabled" as keyof DesktopSettings);
  }
  // FEA-4004: the "Hide Merged & Agent Branches" default-hide was removed
  // entirely (merged/agent/bot branches always show now), so its
  // `branches-hide-cruft` Labs toggle was dropped from the registry. An existing
  // install that opted the Labs flag on (or off) still carries the persisted
  // key; electron-store spreads raw persisted data in getAll(), so it would
  // bleed through to IPC responses. Delete it here so the removed key leaves no
  // residue.
  if ("branches-hide-cruft" in store.store) {
    store.delete("branches-hide-cruft" as keyof DesktopSettings);
  }
  // FEA-4133: first-party desktop Account Sign-In graduated to always-on and its
  // `desktopFirstPartyAuthEnabled` Labs toggle was removed from the type,
  // defaults, and registry. An existing install that persisted the flag (it
  // defaulted `false`) still carries the raw key; electron-store spreads raw
  // persisted data in getAll(), so it would bleed through to IPC responses and
  // no longer conform to DesktopSettings. Delete it so the graduated key leaves
  // no residue.
  if ("desktopFirstPartyAuthEnabled" in store.store) {
    store.delete("desktopFirstPartyAuthEnabled" as keyof DesktopSettings);
  }
  // FEA-3999: the unified GitHub-first onboarding flow graduated to always-on
  // and its `unified-auth-onboarding` Labs toggle was removed from the type,
  // defaults, and registry. An existing install that opted the Labs flag on (or
  // off) still carries the persisted `unified-auth-onboarding` key;
  // electron-store spreads raw persisted data in getAll(), so it would bleed
  // through to IPC responses and no longer conform to DesktopSettings. Delete it
  // so the graduated key leaves no residue.
  if ("unified-auth-onboarding" in store.store) {
    store.delete("unified-auth-onboarding" as keyof DesktopSettings);
  }
  // FEA-4002: the Collapsible Comments Rail graduated to always-on and its
  // `session-comments-rail-collapse` flag was removed from the type, defaults,
  // and registry. It was a persisted DesktopSettings field that defaulted true,
  // so an existing install still carries the raw key; electron-store spreads raw
  // persisted data in getAll(), so it would bleed through to IPC responses and no
  // longer conform to DesktopSettings. Delete it so the graduated key leaves no
  // residue.
  if ("session-comments-rail-collapse" in store.store) {
    store.delete("session-comments-rail-collapse" as keyof DesktopSettings);
  }
  // FEA-4132: Extended Pack Contents graduated to always-on (the packs surfaces
  // no longer gate on it), so its `pack-extended-content-kinds` Labs toggle was
  // removed from the type, defaults, and registry. An existing install that
  // opted the Labs flag on (or off) still carries the persisted key;
  // electron-store spreads raw persisted data in getAll(), so it would bleed
  // through to IPC responses and no longer conform to DesktopSettings. Delete it
  // so the graduated key leaves no residue.
  if ("pack-extended-content-kinds" in store.store) {
    store.delete("pack-extended-content-kinds" as keyof DesktopSettings);
  }
  // ISS-5061 re-gate (reverses ISS-5280 for this ONE key): the Agent
  // Collaboration Network Labs toggle is REGISTERED AGAIN, default OFF, so a
  // persisted value is no longer residue — it is a live setting. Clear whatever
  // an install carried from before the re-gate EXACTLY ONCE, so every install
  // lands on the new OFF default, then leave the key alone: keeping the old
  // unconditional delete would wipe the user's opt-in on every restart.
  if (!store.get("agentCollaborationNetworkResidueCleared", false)) {
    store.delete("agent-collaboration-network");
    store.set("agentCollaborationNetworkResidueCleared", true);
  }
  // ISS-5280: the corrected compute-target sync semantics graduated to
  // always-on, so the `compute-target-sync-semantics` Labs toggle was removed
  // from the registry. It defaulted `false`, so an install that touched the
  // toggle still carries the raw key; electron-store spreads raw persisted data
  // in getAll(), so a stale `false` would bleed through to IPC responses and
  // read as an opt-OUT of a card that no longer has an off state.
  if ("compute-target-sync-semantics" in store.store) {
    store.delete("compute-target-sync-semantics" as keyof DesktopSettings);
  }
  // ISS-5348: the honest import-splash sync footnote graduated to always-on, so
  // the `honest-sync-copy` Labs toggle was removed from the type, defaults, and
  // registry. It defaulted `false`, so an install that touched the toggle still
  // carries the raw key; electron-store spreads raw persisted data in getAll(),
  // so a stale `false` would bleed through to IPC responses, no longer conform
  // to DesktopSettings, and read as an opt-OUT of a footer that no longer has an
  // off state.
  if ("honest-sync-copy" in store.store) {
    store.delete("honest-sync-copy" as keyof DesktopSettings);
  }
  // ISS-5366: a batch of observable-only Labs toggles graduated to always-on, so
  // each was removed from the type, defaults, and registry. Each defaulted
  // `false`, so an install that touched one still carries the raw key;
  // electron-store spreads raw persisted data in getAll(), so a stale `false`
  // would bleed through to IPC responses, no longer conform to DesktopSettings,
  // and read as an opt-OUT of a feature that no longer has an off state. Listed
  // in one array rather than as N more `if` blocks because they retire together
  // and the branches would be byte-identical. ISS-6523 moved that array to
  // `labs-setting-key-ledger.ts`, where a missing entry is now a gate failure
  // instead of a silently-skipped convention.
  for (const retiredKey of RETIRED_LABS_SETTING_KEYS) {
    if (retiredKey in store.store) {
      store.delete(retiredKey as keyof DesktopSettings);
    }
  }
}

/**
 * Migration: rename apiOrigin → relayOrigin, preserve authApiOrigin → apiOrigin.
 * With defaults removed, `store.store` only contains actually-persisted keys, so
 * key-presence checks are reliable.
 */
function migrateOriginRename(
  store: SettingsMigrationTarget["rawStore"],
  raw: Record<string, unknown>
): void {
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
    store.set("relayOrigin", relayOrigin);

    if (hadAuthApiOrigin && typeof oldAuthApiOrigin === "string") {
      // Intermediate build: authApiOrigin held the REST API URL. Promote it.
      let apiOrigin = DEFAULT_DESKTOP_SETTINGS.apiOrigin;
      try {
        apiOrigin = normalizeAndValidateOrigin(oldAuthApiOrigin);
      } catch {
        // Fall back to default on invalid value
      }
      store.set("apiOrigin", apiOrigin);
    } else {
      // Pre-auth install: no REST API origin was ever set. Use default.
      store.set("apiOrigin", DEFAULT_DESKTOP_SETTINGS.apiOrigin);
    }
  }

  // Always clean up stale authApiOrigin key (intermediate build artifact).
  if (hadAuthApiOrigin) {
    store.delete("authApiOrigin" as keyof DesktopSettings);
  }
}

/** Migration: replace legacy "auto" tier with "high" (identical behavior). */
function migrateApprovalTier(
  store: SettingsMigrationTarget["rawStore"],
  raw: Record<string, unknown>
): void {
  if (raw.defaultApprovalTier === "auto") {
    store.set("defaultApprovalTier", "high" as RiskTier);
  }
  const rules = raw.autoApprovalRules as Record<string, string> | undefined;
  if (!rules) {
    return;
  }
  let rulesChanged = false;
  for (const [key, val] of Object.entries(rules)) {
    if (val === "auto") {
      rules[key] = "high";
      rulesChanged = true;
    }
  }
  if (rulesChanged) {
    store.set(
      "autoApprovalRules",
      rules as unknown as Record<string, RiskTier>
    );
  }
}

/**
 * ISS-9175: electron-store has no schema, so a non-array `alwaysAllowRules`
 * (`{}`, `null`, a string) can be on disk. `getAll()` reads it as `[]`, but
 * nothing else rewrites it, so repair the raw value once here; an older build
 * reading the file after a rollback then sees `[]` too. An absent key is left
 * absent.
 */
function migrateAlwaysAllowRulesContainer(
  store: SettingsMigrationTarget["rawStore"],
  raw: Record<string, unknown>
): void {
  if ("alwaysAllowRules" in raw && !Array.isArray(raw.alwaysAllowRules)) {
    store.set("alwaysAllowRules", []);
  }
}

/**
 * Migration: initialize savedConfigs and activeConfigId for existing installs.
 * TODO(PLN-116-cleanup): Remove this migration block once all existing installs
 * have been upgraded.
 */
function migrateSavedConfigsInit(
  store: SettingsMigrationTarget["rawStore"],
  raw: Record<string, unknown>
): void {
  if (!Array.isArray(raw.savedConfigs)) {
    store.set("savedConfigs", []);
  }
  if (!("activeConfigId" in raw)) {
    store.set("activeConfigId", null as DesktopSettings["activeConfigId"]);
  }
}

/**
 * Reconcile legacy connectivity without manufacturing consent. ISS-12523:
 * an old profile with no explicit answer stays unset, even if its effective
 * flags allowed sync. Persist null before any level writes so older builds
 * also preserve that unanswered state rather than infer a grant on next boot.
 */
function migrateDataSyncLevel(
  target: SettingsMigrationTarget,
  raw: Record<string, unknown>,
  firstLaunch: boolean
): void {
  // The tier is the one dimension we may never overwrite: an explicit choice is
  // authoritative — INCLUDING an explicit `null` ("not consented yet") that the
  // SyncConsent UI persists via `SettingsStore.update`. So key ABSENCE, not a null
  // read, is what marks an install that never chose. Captured before any write.
  const tierAbsent = !("syncObservabilityTier" in raw);
  const onboardingCompleted = raw.onboardingCompleted === true;

  // ISS-10554 — FIRST LAUNCH: nothing had ever been persisted when this boot
  // started, so the device has made no choice to preserve and is the one case a
  // new default may establish. `runSettingsMigrations` already seeded it, ahead of
  // every other migration, so there is nothing here to reconcile. An install that
  // merely never touched sync is NOT this case — it already carries keys from an
  // earlier boot — and is left alone.
  if (firstLaunch) {
    return;
  }

  if (tierAbsent) {
    target.rawStore.set("syncObservabilityTier", null);
  }
  if ("dataSyncLevel" in raw && raw.dataSyncLevel != null) {
    return;
  }

  // The superseded connectivity/sync flags this install actually persisted.
  const hasLegacyFlags =
    "cloudConnectionEnabled" in raw ||
    "transcriptSyncEnabled" in raw ||
    "cloudCommandsPaused" in raw ||
    "syncObservabilityTier" in raw;
  // Already part of the sync world — either it carried the superseded flags, or it
  // completed onboarding before the tier step existed (the FEA-3462 stranded case).
  // A fresh install matches neither: derive nothing, manufacture no consent.
  if (!(hasLegacyFlags || onboardingCompleted)) {
    return;
  }

  if (hasLegacyFlags) {
    // Persist the level AND its derived connectivity booleans so the two can never
    // disagree from the first boot after upgrade. The level here is the display
    // anchor (connectivity-baked, reconciled on read), not evidence of consent.
    const level = legacyFlagsToDataSyncLevel(liveLegacyFlags(target));
    const derived = dataSyncLevelToBooleans(level);
    target.rawStore.set("dataSyncLevel", level);
    target.setFlag("cloudConnectionEnabled", derived.cloudConnectionEnabled);
    // Preserve an explicit pre-existing pause across the one-time migration: a
    // paused-but-connected install reconciles to a non-Off level whose derived
    // `cloudCommandsPaused` is false, which would silently un-pause remote commands
    // the user explicitly paused. Only write the derived value when the user never
    // set the flag themselves. When the derived level is Off the derived value is
    // already `true` (paused), so honoring a persisted pause never widens exposure.
    if (target.getFlagSource("cloudCommandsPaused") !== "user") {
      target.setFlag("cloudCommandsPaused", derived.cloudCommandsPaused);
    }
    target.setFlag("transcriptSyncEnabled", derived.transcriptSyncEnabled);
  }
}

/**
 * ISS-10554 — put a FIRST-LAUNCH install on `level` and persist the connectivity
 * booleans it derives, so `getDataSyncLevel`'s reconciliation against the live
 * flags agrees with it instead of pulling it back down to the metadata floor.
 *
 * `syncObservabilityTier` is written as an EXPLICIT `null` — "this device has
 * recorded an answer, and the answer is not-consented". Leaving the key absent
 * instead is what makes the seed dangerous, because absence is the signal every
 * build reads as "never chose, infer from behavior": the seeded transcript flag
 * is exactly the evidence older builds read as "this device was
 * full-syncing", so a later boot — of THIS build without the key, or of an OLDER
 * build that cannot know about any marker this one invents — would grandfather a
 * `full` consent tier nobody agreed to. An explicit `null` is authoritative and
 * never overwritten, so the tier stays the user's to answer. It grants nothing:
 * `hasRecordedSyncConsent` and the egress gate both read the VALUE, and a null
 * tier fails closed.
 *
 * ONE object write, for the same reason {@link SettingsStore.setDataSyncLevel}
 * uses one: electron-store persists the whole config file per `set`, so separate
 * calls can be torn by a crash, and a tear that landed the level without the
 * tier is precisely the state above.
 *
 * Only the flags the level actually CHANGES are written. A persisted key is what
 * `getFlagSource` reports as a user choice, so writing a flag whose registry
 * default already equals the derived value would relabel a default as a decision
 * the user never made — and `migrateDataSyncLevel` reads exactly that source to
 * decide whether an upgrading install's pause is deliberate.
 */
function seedRecommendedDataSyncLevel(
  target: SettingsMigrationTarget,
  level: DataSyncLevel
): void {
  const derived = dataSyncLevelToBooleans(level);
  const seed: Partial<DesktopSettings> = {
    dataSyncLevel: level,
    syncObservabilityTier: null,
  };
  for (const [key, value] of [
    ["cloudConnectionEnabled", derived.cloudConnectionEnabled],
    ["cloudCommandsPaused", derived.cloudCommandsPaused],
    ["transcriptSyncEnabled", derived.transcriptSyncEnabled],
  ] as const) {
    if (target.getFlag(key) !== value) {
      seed[key] = value;
    }
  }
  target.rawStore.set(seed);
}

/**
 * The legacy connectivity/sync flags read exactly as their runtime consumers do
 * (env override → user-set → registry default), so a reconciliation reflects
 * effective behavior rather than raw persisted presence.
 */
function liveLegacyFlags(target: SettingsMigrationTarget): LegacyDataSyncFlags {
  return {
    cloudConnectionEnabled: target.getFlag("cloudConnectionEnabled"),
    transcriptSyncEnabled: target.getFlag("transcriptSyncEnabled"),
    syncObservabilityTier: target.getSyncObservabilityTier(),
  };
}

/**
 * Reconciles each saved profile's `apiKeySource` against whether it actually
 * carries a valid managed gateway identity, so a profile can never claim
 * `DESKTOP_MANAGED` without the UUID + public key that provenance implies.
 */
function migrateSavedConfigManagedFields(
  target: SettingsMigrationTarget
): void {
  const { configs, changed } = reconcileManagedApiKeySources(
    target.getSavedConfigs()
  );
  if (changed) {
    target.setSavedConfigs(configs);
  }
}

/**
 * PRD-797 (Q-004): the pre-rename `scheduledTasks` shadow of the retired
 * `routines` Labs key. It was never a registry flag, so it is not on the ledger
 * `RETIRED_LABS_SETTING_KEYS` is checked against.
 */
function removeRetiredScheduledTasksShadow(
  store: SettingsMigrationTarget["rawStore"]
): void {
  if ("scheduledTasks" in store.store) {
    store.delete("scheduledTasks" as keyof DesktopSettings);
  }
}
