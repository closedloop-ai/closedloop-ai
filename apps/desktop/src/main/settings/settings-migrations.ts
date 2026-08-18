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
  grandfatherConsentTier,
  legacyFlagsToDataSyncLevel,
} from "../../shared/data-sync-level.js";
import type { FlagKey } from "../../shared/feature-flags.js";
import { RETIRED_LABS_SETTING_KEYS } from "./labs-setting-key-ledger.js";
import { normalizeAndValidateOrigin } from "./origin-policy.js";
import { isUuidV4 } from "./saved-config.js";

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
 * The FEA-3462 stranded sync-consent reconciliation and the FEA-3907
 * data-sync-level backfill are now a single pass (`migrateDataSyncLevel`): both
 * answer "what consent tier does an upgrading install carry?", and splitting them
 * let a full-syncing install fall through the gap — level backfilled, tier left
 * null — and go dark once `unified-auth-onboarding` turned on. See that function.
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
  // PRD-566 / FEA-4348: run the Scheduled Tasks → Routines opt-in copy BEFORE
  // `removeRetiredKeys` so the legacy `scheduledTasks` value is still present to
  // read. It deletes the legacy key itself after copying.
  migrateScheduledTasksToRoutines(store);
  removeRetiredKeys(store);

  const raw = store.store;
  migrateOriginRename(store, raw);
  migrateApprovalTier(store, raw);
  migrateSavedConfigsInit(store, raw);
  migrateSavedConfigManagedFields(target);
  // Reconciles BOTH the data-sync level and the stranded sync-consent tier
  // (formerly `migrateStrandedSyncConsent`, FEA-3462) in one pass.
  migrateDataSyncLevel(target, raw);
}

/**
 * PRD-566 / FEA-4348: the "Scheduled Tasks" Labs flag was renamed to "Routines"
 * — the persisted DesktopSettings field is now `routines`, with `scheduledTasks`
 * kept as a compatibility SHADOW so the rename is not a one-way door.
 *
 * Why a shadow and not a delete-after-copy: deleting `scheduledTasks` made the
 * rename one-way (wongk, PR #3896). If a user downgrades to a pre-rename build,
 * that build reads only `scheduledTasks` — with the key gone the scheduler
 * defaults OFF, and if they then re-toggle `scheduledTasks` there, a plain
 * "seed only when routines unset" re-upgrade would ignore their newer choice
 * because `routines` already exists. So instead we DUAL-WRITE through the
 * rollback window: `routines` is authoritative on new builds, and it is
 * mirrored back into `scheduledTasks` (here at boot, and on every `setFlag`)
 * so an old build always sees the current value.
 *
 * Precedence (covers new→old→new): on boot, if BOTH keys exist and disagree,
 * the legacy `scheduledTasks` wins — the only way they diverge is an old build
 * writing it while `routines` stayed frozen, so the legacy value is the newer
 * user intent. Otherwise `routines` (or the seeded legacy value) wins and is
 * mirrored down. Idempotent and non-escalating: a legacy `false` is honored, so
 * an explicit opt-OUT survives a round-trip rather than defaulting back on.
 *
 * The shadow bleeds `scheduledTasks` through `getAll()` (electron-store spreads
 * raw persisted data in IPC responses), which is acceptable and intended for
 * the rollback window — it is a known boolean mirror, not stale cruft. Retire
 * the shadow (and this migration) only once all installs are past the rename
 * (Compatibility Guardrail).
 */
function migrateScheduledTasksToRoutines(
  store: SettingsMigrationTarget["rawStore"]
): void {
  const hasLegacy = "scheduledTasks" in store.store;
  const hasRoutines = "routines" in store.store;
  if (!(hasLegacy || hasRoutines)) {
    return;
  }
  const legacyValue = store.get("scheduledTasks" as keyof DesktopSettings) as
    | boolean
    | undefined;
  const routinesValue = store.get("routines" as keyof DesktopSettings) as
    | boolean
    | undefined;

  // Resolve the authoritative value for this boot. A legacy value that DISAGREES
  // with `routines` means an older build wrote `scheduledTasks` while `routines`
  // stayed frozen (new→old→new) — that newer user intent wins. Otherwise prefer
  // `routines`, falling back to the legacy seed on a fresh post-rename read.
  let effective: boolean | undefined;
  if (
    typeof legacyValue === "boolean" &&
    typeof routinesValue === "boolean" &&
    legacyValue !== routinesValue
  ) {
    effective = legacyValue;
  } else {
    effective = routinesValue ?? legacyValue;
  }

  if (typeof effective !== "boolean") {
    return;
  }
  // Authoritative on new builds…
  store.set("routines" as keyof DesktopSettings, effective as never);
  // …mirrored into the legacy shadow so a downgrade still reads the current
  // value instead of silently defaulting the scheduler off.
  store.set("scheduledTasks" as keyof DesktopSettings, effective as never);
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
 * FEA-3907 (+ FEA-3462) — reconcile an UPGRADING install onto the graduated data
 * sync level AND establish the PRD-532 §7 consent tier it carries, in one pass.
 * These are two answers to the same question ("how much of my data went to the
 * cloud before the level/tier concept existed?"), and keeping them separate is
 * what let a real regression through: a pre-fix build backfilled the LEVEL from
 * the legacy flags but deliberately left `syncObservabilityTier` null, and the
 * separate FEA-3462 reconciliation only backfilled a `metadata` floor for installs
 * with `onboardingCompleted: true`. An install that was full-syncing but never
 * completed onboarding (full transcript sync was the ONLY behavior before the
 * tier concept) fell through both: level `full`, tier null. Once
 * `unified-auth-onboarding` turned on, the app.ts gates read that null tier as
 * "not consented yet" and HARD-DISABLED both the metadata and transcript lanes —
 * the install goes dark while the Data & Sync tab still shows "Full".
 *
 * Fix: whenever an install was already part of the sync world and never made an
 * explicit tier choice, grandfather the consent tier from what it was ACTUALLY
 * doing (see {@link grandfatherConsentTier}), so the level and the gate can never
 * disagree:
 *   - was full-syncing (transcript lane on) → `full`   — the behavior it had.
 *   - metadata-only (connected, transcript off) → `metadata`.
 *   - disconnected / nothing syncing → grandfather NOTHING (`null`), EXCEPT an
 *     onboarded legacy install floors at `metadata` (preserving the FEA-3462 floor
 *     so a later reconnect resumes the aggregate lane instead of staying gated on
 *     `null`).
 * Full transcript sync was the product's only pre-tier behavior, so restoring
 * `full` for a transcript-syncing legacy install is continuity, not a new grant
 * (product decision: a full-syncer is not silently downgraded).
 *
 * The consent inference is ONE connectivity-aware SSOT (`grandfatherConsentTier`),
 * called identically whether or not the level was already settled — replacing the
 * older split that derived a tier from a *level* (the reconciled `getDataSyncLevel`
 * on the already-leveled path, the legacy-flag level on the other) and then
 * special-cased `local`. Both paths computed the same answer two different ways.
 *
 * Two guards keep this from over-reaching:
 *   1. "Never made an explicit tier choice" means the `syncObservabilityTier` key
 *      is ABSENT — not merely null-valued. The SyncConsent UI persists an explicit
 *      `null` ("not consented yet") through `SettingsStore.update`, so a present-but-
 *      null tier is an authoritative choice we must not overwrite.
 *   2. `grandfatherConsentTier` reads live connectivity, so a persisted `full` on a
 *      now-disconnected store grandfathers no `full` tier (it is disconnected →
 *      nothing was syncing), exactly as reconciling the stale level to Off did.
 *
 * A BRAND-NEW install matches nothing here: no level is derived and — critically —
 * no `syncObservabilityTier` is written, so a fresh device stays in the
 * not-yet-consented (`null`) state and a deliberate `setDataSyncLevel` (the
 * Settings control) remains the only path that establishes a tier from scratch.
 */
function migrateDataSyncLevel(
  target: SettingsMigrationTarget,
  raw: Record<string, unknown>
): void {
  // The tier is the one dimension we may never overwrite: an explicit choice is
  // authoritative — INCLUDING an explicit `null` ("not consented yet") that the
  // SyncConsent UI persists via `SettingsStore.update`. So key ABSENCE, not a null
  // read, is what marks an install that never chose. Captured before any write.
  const tierAbsent = !("syncObservabilityTier" in raw);
  const onboardingCompleted = raw.onboardingCompleted === true;

  // Path 1: the LEVEL was already settled by a prior boot. A pre-fix FEA-3907
  // migration settled it but never established the tier, so an upgraded install can
  // carry a syncing level with an absent tier — the exact go-dark state. Grandfather
  // the consent tier from the live legacy flags (which reflect the persisted level's
  // own connectivity/transcript booleans plus any out-of-band Relay toggle).
  if ("dataSyncLevel" in raw && raw.dataSyncLevel != null) {
    if (tierAbsent) {
      grandfatherConsent(target, onboardingCompleted);
    }
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
    // anchor (connectivity-baked, reconciled on read); the durable consent tier is
    // established separately below via `grandfatherConsentTier`.
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

  // Establish the durable consent tier (unless the user already chose one).
  if (tierAbsent) {
    grandfatherConsent(target, onboardingCompleted);
  }
}

/**
 * Grandfather an upgrading install's PRD-532 §7 consent tier from its live legacy
 * flags, persisting it only when one is warranted. The caller guards on the
 * `syncObservabilityTier` key being ABSENT, so this never overwrites an explicit
 * choice. See {@link grandfatherConsentTier} for the non-escalating inference.
 */
function grandfatherConsent(
  target: SettingsMigrationTarget,
  onboardingCompleted: boolean
): void {
  const tier = grandfatherConsentTier(
    liveLegacyFlags(target),
    onboardingCompleted
  );
  if (tier !== null) {
    target.rawStore.set("syncObservabilityTier", tier);
  }
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
  const configs = target.getSavedConfigs();
  let changed = false;
  const migrated = configs.map((config) => {
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

  if (changed) {
    target.setSavedConfigs(migrated);
  }
}
