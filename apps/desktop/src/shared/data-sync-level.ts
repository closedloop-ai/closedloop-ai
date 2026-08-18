import { DataSyncLevel, type SyncObservabilityTier } from "./contracts.js";

/**
 * FEA-3907 — the graduated "data sync level": ONE product control in Settings
 * that answers "how much of my data goes to the cloud?" and supersedes the four
 * scattered Labs/config toggles that used to answer it piecemeal
 * (`cloudConnectionEnabled`, `cloudCommandsPaused`, `transcriptSyncEnabled`, and
 * the sync-observability tier). This module is the SINGLE SOURCE OF TRUTH for
 * level → the connectivity/sync booleans the runtime already consumes: every
 * consumer keeps reading its own boolean; the level just derives them together
 * so a user can no longer put them in a contradictory combination.
 *
 * The {@link DataSyncLevel} const/type itself lives in `contracts.ts` (next to
 * `SyncObservabilityTier`) to avoid a circular import; this module owns the
 * ranking, the level → booleans mapping, and the backward-compat migration.
 *
 * Ranked least-to-most exposure — the RANKING, not a render order (ISS-5318
 * renders the picker most-permissive first):
 *   Off < Metadata only (fresh-install default) < Redacted sessions < Full transcripts.
 *
 * NOT superseded here: the per-tool `collect{Claude,Cursor,Copilot}Enabled`
 * flags. Those gate LOCAL collection (what the desktop reads off disk to
 * populate the on-device dashboard), which is orthogonal to cloud egress — an
 * "Off" level still shows the local dashboard. They keep their own "Data
 * Collection" card (CLI Tools tab, already outside Labs). Folding their
 * destructive removal into the level is deferred (see the FEA-3907 PR); the
 * level never forces a user's disabled collector back on.
 */

/** All levels, least-to-most exposure. */
export const DATA_SYNC_LEVELS: readonly DataSyncLevel[] = [
  DataSyncLevel.Off,
  DataSyncLevel.Metadata,
  DataSyncLevel.Redacted,
  DataSyncLevel.Full,
];

/**
 * What a fresh install lands on. Metadata unlocks cloud insights without ever
 * uploading prompt or file contents. Carries no chip of its own since ISS-5318:
 * where the selection starts is not a claim the picker needs to make.
 */
export const DEFAULT_DATA_SYNC_LEVEL: DataSyncLevel = DataSyncLevel.Metadata;

/** The most-permissive level — the one `dataSyncLevelBadge` marks "Recommended". */
export const ELEVATED_DATA_SYNC_LEVEL: DataSyncLevel = DataSyncLevel.Full;

// FEA-4055: the per-level PRESENTATIONAL copy (titles, benefit lines, per-line
// egress breakdown, caveats) no longer lives here. It moved to the shared
// `@repo/app/shared/lib/data-sync-copy` module so the desktop Settings "Data &
// Sync" tab AND the onboarding sync-consent step render from ONE copy source and
// can never drift. This module (imported by the desktop MAIN process) keeps only
// the value logic — ranking, defaults, the boolean mapping, and the migration —
// so the presentational copy is never pulled into the main-process bundle. The
// renderer reads `DATA_SYNC_LEVEL_COPY` / `findDataSyncLevelCopy` from the shared
// module; a renderer parity test pins that copy's per-line egress against
// `dataSyncLevelToBooleans` below.

/**
 * The set of persisted settings a DELIBERATE level pick derives. Every field is
 * a value an existing runtime consumer already reads. `syncObservabilityTier` is
 * the PRD-532 §7 lane gate the level folds in so an active choice keeps the level
 * and tier consistent. NOTE: the one-time upgrade MIGRATION does not establish the
 * consent tier from THIS map — it grandfathers the tier from the install's actual
 * prior behavior via {@link grandfatherConsentTier}, and only when no explicit tier
 * was ever persisted (see `migrateDataSyncLevel` in `settings-migrations.ts`), so a
 * silent migration never overwrites a deliberate choice.
 */
export type DataSyncLevelBooleans = {
  cloudConnectionEnabled: boolean;
  cloudCommandsPaused: boolean;
  transcriptSyncEnabled: boolean;
  syncObservabilityTier: SyncObservabilityTier;
};

/**
 * Level → the connectivity/sync booleans the runtime consumes. This is the SSOT
 * mapping: the settings store persists the level and derives these on read, so
 * no downstream consumer of the individual flags changes behavior.
 *
 * | Level    | connection | paused | transcriptSync | tier     |
 * | -------- | ---------- | ------ | -------------- | -------- |
 * | off      | false      | true   | false          | local    |
 * | metadata | true       | false  | false          | metadata |
 * | redacted | true       | false  | false          | metadata |
 * | full     | true       | false  | true           | full     |
 *
 * `redacted` currently derives the same booleans as `metadata` (no transcript
 * bodies): the redaction lane is not plumbed yet, so redacted honestly behaves
 * as metadata-only sync until it ships. It stays a distinct level so the UI and
 * the persisted choice are forward-compatible.
 */
export function dataSyncLevelToBooleans(
  level: DataSyncLevel
): DataSyncLevelBooleans {
  switch (level) {
    case DataSyncLevel.Off:
      return {
        cloudConnectionEnabled: false,
        // Paused when off so any still-open relay never executes a remote
        // command — matches the pre-FEA-3907 "disconnected" posture.
        cloudCommandsPaused: true,
        transcriptSyncEnabled: false,
        syncObservabilityTier: "local",
      };
    case DataSyncLevel.Metadata:
      return {
        cloudConnectionEnabled: true,
        cloudCommandsPaused: false,
        transcriptSyncEnabled: false,
        syncObservabilityTier: "metadata",
      };
    case DataSyncLevel.Redacted:
      return {
        cloudConnectionEnabled: true,
        cloudCommandsPaused: false,
        transcriptSyncEnabled: false,
        syncObservabilityTier: "metadata",
      };
    case DataSyncLevel.Full:
      return {
        cloudConnectionEnabled: true,
        cloudCommandsPaused: false,
        transcriptSyncEnabled: true,
        syncObservabilityTier: "full",
      };
    default:
      // Exhaustiveness guard: a new level must be mapped here or fail typecheck.
      return assertNeverLevel(level);
  }
}

/** The persisted flag combination an upgrading install carries into FEA-3907. */
export type LegacyDataSyncFlags = {
  cloudConnectionEnabled: boolean;
  transcriptSyncEnabled: boolean;
  /** Nullable: `null` means the user never consented to a tier (legacy-allow). */
  syncObservabilityTier: SyncObservabilityTier | null;
};

/**
 * Backward-compat migration (FEA-3907): map an upgrading install's existing flag
 * combination to the nearest new level WITHOUT escalating the user's data
 * exposure. When a combination is ambiguous, we choose the LESS-permissive
 * level.
 *
 * Precedence:
 *  1. Cloud connection OFF → `off`, regardless of anything else (nothing was
 *     leaving the device).
 *  2. Sync-observability tier `local` → `off`, regardless of the other flags: a
 *     `local` tier blocked all sync, so a stale `transcriptSyncEnabled=true`
 *     paired with it must not escalate to `full` (nothing was actually syncing).
 *  3. Transcript sync ON (connection on, tier not `local`) → `full` — the user
 *     had already opted into full transcript export, so this is not an
 *     escalation.
 *  4. Otherwise the connection is on but transcripts are off. The
 *     sync-observability tier, when the user explicitly chose one, disambiguates
 *     toward the matching level; absent that, we default to the safe floor
 *     `metadata` (never `redacted`/`full`) so the migration cannot widen
 *     exposure. A `full` tier here is honored (the user consented to it) but the
 *     transcript lane stays off until they raise the level, matching the old
 *     behavior.
 */
export function legacyFlagsToDataSyncLevel(
  flags: LegacyDataSyncFlags
): DataSyncLevel {
  if (!flags.cloudConnectionEnabled) {
    return DataSyncLevel.Off;
  }
  // A `local` tier blocked ALL sync regardless of any other flag, so it wins
  // before the transcript check below: a stale `transcriptSyncEnabled=true`
  // paired with a tier that pinned the lane to local must not escalate to Full
  // (nothing was actually leaving the device). The less-permissive
  // reconciliation is Off.
  if (flags.syncObservabilityTier === "local") {
    return DataSyncLevel.Off;
  }
  if (flags.transcriptSyncEnabled) {
    return DataSyncLevel.Full;
  }
  if (flags.syncObservabilityTier === "full") {
    // The user consented to full-detail sync but had transcript archiving off.
    // Redacted is the nearest level whose sync tier is not below their consent
    // without turning the elevated transcript lane on for them.
    return DataSyncLevel.Redacted;
  }
  // `metadata` tier, or no explicit tier (legacy-allow): the safe floor.
  return DataSyncLevel.Metadata;
}

/**
 * FEA-4103 — map a legacy `SyncObservabilityTier` (the pre-FEA-3907 consent
 * value) to the canonical {@link DataSyncLevel}. This is the SSOT inverse of the
 * `syncObservabilityTier` column in {@link dataSyncLevelToBooleans}, so the two
 * can never disagree about what a tier means:
 *
 *   local → off · metadata → metadata · full → full
 *
 * Used to collapse the last independent consent-tier setter (the legacy
 * `desktop:set-sync-observability-tier` IPC) onto the one canonical write path:
 * instead of persisting `syncObservabilityTier` alone — which left the other
 * derived flags (transcript lane, connectivity) untouched and could make the
 * "Data & Sync" level display disagree with the enforced egress — a tier pick is
 * routed through `applyDataSyncLevel(tier → level)` so every derived boolean is
 * written together. `redacted` has no legacy tier of its own (it derives the
 * `metadata` tier), so it is unreachable from this direction; a tier of
 * `metadata` maps to the `Metadata` level, never `Redacted`, so the shim never
 * silently widens exposure.
 */
export function syncObservabilityTierToDataSyncLevel(
  tier: SyncObservabilityTier
): DataSyncLevel {
  switch (tier) {
    case "local":
      return DataSyncLevel.Off;
    case "metadata":
      return DataSyncLevel.Metadata;
    case "full":
      return DataSyncLevel.Full;
    default:
      return assertNeverTier(tier);
  }
}

/**
 * Validate a renderer-supplied data sync level server-side (FEA-3907).
 * Defense-in-depth on top of the trusted-sender boundary: a compromised or
 * partial renderer must not persist an out-of-contract level. Throws on anything
 * other than the four literals. Lives in `shared/` (no `electron` import) so the
 * main-process IPC handler and node:test can both use it.
 */
export function normalizeDataSyncLevel(value: unknown): DataSyncLevel {
  if (
    typeof value === "string" &&
    (DATA_SYNC_LEVELS as readonly string[]).includes(value)
  ) {
    return value as DataSyncLevel;
  }
  throw new Error(
    `Invalid data sync level: expected one of ${DATA_SYNC_LEVELS.join(", ")}`
  );
}

/**
 * Coerce a persisted `dataSyncLevel` read off disk into a known level (FEA-3907).
 * The stored value is untrusted: a downgrade from a NEWER Desktop build can leave
 * a level string this build has no mapping for, and the one-time upgrade migration
 * skips a present-but-newer value (it only backfills an absent level). Feeding
 * that string into {@link dataSyncLevelToBooleans} would trip the exhaustiveness
 * guard and throw. Return the value when it is one of the four known levels;
 * otherwise fall back to the non-escalating {@link legacyFlagsToDataSyncLevel}
 * derivation from the live flags (the safe floor), never an unknown literal.
 */
export function coercePersistedDataSyncLevel(
  value: unknown,
  liveFlags: LegacyDataSyncFlags
): DataSyncLevel {
  if (
    typeof value === "string" &&
    (DATA_SYNC_LEVELS as readonly string[]).includes(value)
  ) {
    return value as DataSyncLevel;
  }
  return legacyFlagsToDataSyncLevel(liveFlags);
}

/**
 * Reconcile a persisted level against the live connectivity flags (FEA-3907).
 * The persisted `dataSyncLevel` is the SSOT only while nothing changes the
 * underlying flags out-of-band; the Relay/Gateway tab's live toggles set
 * `cloudConnectionEnabled` / `cloudCommandsPaused` directly without round-tripping
 * through the level. When the persisted level's derived connectivity booleans no
 * longer match the live flags, re-derive from the live flags (via the same
 * non-escalating {@link legacyFlagsToDataSyncLevel} mapping the upgrade migration
 * uses) so a display can never show a level that disagrees with the real state.
 */
export function reconcileDataSyncLevel(
  persisted: DataSyncLevel,
  liveFlags: LegacyDataSyncFlags
): DataSyncLevel {
  const derived = dataSyncLevelToBooleans(persisted);
  if (
    derived.cloudConnectionEnabled === liveFlags.cloudConnectionEnabled &&
    derived.transcriptSyncEnabled === liveFlags.transcriptSyncEnabled
  ) {
    return persisted;
  }
  return legacyFlagsToDataSyncLevel(liveFlags);
}

/**
 * FEA-4103 follow-up — the SINGLE consent-inference SSOT the settings migration
 * uses to GRANDFATHER an upgrading install's PRD-532 §7 consent tier from its
 * legacy connectivity/sync flags, or `null` to record no consent. It replaces the
 * older two-path approach (derive a level from the legacy flags OR from the
 * reconciled persisted level, map that level back to a tier, then special-case
 * `local`), which computed the same answer two different ways and could drift.
 *
 * Connectivity-aware and non-escalating:
 *   - Disconnected, or a legacy tier pinned to `local` (both mean "was syncing
 *     nothing") → grandfather NOTHING (`null`), EXCEPT an install that completed
 *     onboarding, which keeps the FEA-3462 `metadata` floor so a later reconnect
 *     resumes the aggregate lane instead of staying gated on `null`.
 *   - Connected → `full` iff it was transcript-syncing (full transcript sync was
 *     the only pre-tier behavior, so this is continuity, not a new grant), else
 *     the `metadata` floor. `metadata`/`local` never upload transcript contents.
 *
 * Only meaningful when the install never made an explicit tier choice — the caller
 * guards on the `syncObservabilityTier` key being ABSENT, so `flags` carries a
 * `null` tier here; an explicit tier (including an explicit `null`) is
 * authoritative and must not be reinterpreted. This is the tier-valued twin of
 * {@link legacyFlagsToDataSyncLevel}: for every input, the tier it returns equals
 * `dataSyncLevelToBooleans(legacyFlagsToDataSyncLevel(flags)).syncObservabilityTier`
 * with the same `local → onboarded ? metadata : null` floor.
 */
export function grandfatherConsentTier(
  flags: LegacyDataSyncFlags,
  onboardingCompleted: boolean
): SyncObservabilityTier | null {
  if (
    !flags.cloudConnectionEnabled ||
    flags.syncObservabilityTier === "local"
  ) {
    return onboardingCompleted ? "metadata" : null;
  }
  if (flags.transcriptSyncEnabled) {
    return "full";
  }
  return "metadata";
}

function assertNeverLevel(level: never): never {
  throw new Error(`Unhandled data sync level: ${String(level)}`);
}

function assertNeverTier(tier: never): never {
  throw new Error(`Unhandled sync observability tier: ${String(tier)}`);
}
