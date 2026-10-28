import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import type { AuthMethod } from "@repo/app/onboarding/components/auth-methods"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import type {
  OrganizationDetails,
  WizardPhase,
} from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import {
  GuidedSyncLevel,
  WIZARD_PHASES,
} from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import type { SyncConsentLevel } from "@repo/app/onboarding/components/sync-consent"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { isRecord } from "@repo/lib/harness/type-guards";
import type { FtuePhase } from "./ftue-progress-context";
import type { PrototypeMode } from "./prototype-developer-menu";

export type GuidedFtueState = {
  accountCreated: boolean;
  accountMethod: AuthMethod | null;
  accountSkipped: boolean;
  dashboardTourCompleted: boolean;
  desktopAppDownloaded: boolean;
  githubConnected: boolean;
  invitedEmails: string[];
  organizationChosen: boolean;
  organizationDetails: OrganizationDetails;
  phase: FtuePhase;
  phaseHistory: FtuePhase[];
  progress: number;
  resumingInvite: boolean;
  /** `null` until the reader chooses; an explicit Off is a choice (ISS-12363). */
  syncLevel: SyncConsentLevel | null;
  teamInvited: boolean;
};

export function createInitialGuidedFtueState(): GuidedFtueState {
  return {
    accountCreated: false,
    accountMethod: null,
    accountSkipped: false,
    dashboardTourCompleted: false,
    desktopAppDownloaded: false,
    githubConnected: false,
    invitedEmails: [],
    organizationChosen: false,
    organizationDetails: { ...DEFAULT_FIRST_ORGANIZATION },
    phase: OnboardingPhase.Welcome,
    phaseHistory: [],
    progress: 0,
    resumingInvite: false,
    syncLevel: null,
    teamInvited: false,
  };
}

export function getGuidedFtueStorageKey(
  mode: PrototypeMode,
  organizationMemberCount: number
): string {
  const scenario = organizationMemberCount > 0 ? "51st-user" : "first-user";
  return `${GUIDED_FTUE_STORAGE_PREFIX}:${mode}:${scenario}`;
}

export function readGuidedFtueState(
  storage: Pick<Storage, "getItem">,
  storageKey: string
): GuidedFtueState | null {
  try {
    const value = storage.getItem(storageKey);
    if (!value) {
      return null;
    }
    return parseGuidedFtueState(JSON.parse(value));
  } catch {
    return null;
  }
}

export function writeGuidedFtueState(
  storage: Pick<Storage, "setItem">,
  storageKey: string,
  state: GuidedFtueState
): boolean {
  try {
    storage.setItem(
      storageKey,
      JSON.stringify({ state, version: GUIDED_FTUE_STORAGE_VERSION })
    );
    return true;
  } catch {
    return false;
  }
}

export function removeGuidedFtueState(
  storage: Pick<Storage, "removeItem">,
  storageKey: string
): boolean {
  try {
    storage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

function parseGuidedFtueState(value: unknown): GuidedFtueState | null {
  if (!isRecord(value) || value.version !== GUIDED_FTUE_STORAGE_VERSION) {
    return null;
  }
  const state = value.state;
  if (!isRecord(state)) {
    return null;
  }

  // `null` is the unset policy and is a valid snapshot; only a value that is
  // neither unset nor a known level makes the snapshot corrupt.
  const syncLevel =
    state.syncLevel === null
      ? null
      : parseSyncLevel(state.syncLevel ?? state.syncPolicy);
  if (
    !(
      isFtuePhase(state.phase) &&
      isPhaseHistory(state.phaseHistory) &&
      isAccountMethod(state.accountMethod) &&
      isOrganizationDetails(state.organizationDetails) &&
      isStringArray(state.invitedEmails) &&
      isBooleanState(state)
    ) ||
    syncLevel === undefined ||
    !isPersistedProgress(state.progress)
  ) {
    return null;
  }

  return {
    accountCreated: state.accountCreated,
    accountMethod: state.accountMethod,
    accountSkipped: state.accountSkipped,
    dashboardTourCompleted: state.dashboardTourCompleted,
    desktopAppDownloaded: state.desktopAppDownloaded,
    githubConnected: state.githubConnected,
    invitedEmails: state.invitedEmails.slice(0, MAX_PERSISTED_INVITES),
    organizationChosen: state.organizationChosen,
    organizationDetails: state.organizationDetails,
    phase: state.phase,
    phaseHistory: state.phaseHistory,
    progress: state.progress,
    resumingInvite: state.resumingInvite,
    syncLevel,
    teamInvited: state.teamInvited,
  };
}

function parseSyncLevel(value: unknown): SyncConsentLevel | undefined {
  if (value === GuidedSyncLevel.Full) {
    return GuidedSyncLevel.Full;
  }
  if (value === GuidedSyncLevel.Metadata || value === LEGACY_SYNC_INSIGHTS) {
    return GuidedSyncLevel.Metadata;
  }
  if (value === GuidedSyncLevel.Off || value === LEGACY_SYNC_LOCAL) {
    return GuidedSyncLevel.Off;
  }
  return undefined;
}

// A snapshot is valid or absent — never repaired. Clamping an impossible
// `progress` (101, -1, 1.5) into range restores the wizard as confidently
// complete off corrupt input instead of starting the fresh flow an invalid
// snapshot promises.
function isPersistedProgress(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 100
  );
}

function isFtuePhase(value: unknown): value is FtuePhase {
  return typeof value === "string" && FTUE_PHASE_SET.has(value as FtuePhase);
}

function isPhaseHistory(value: unknown): value is FtuePhase[] {
  return Array.isArray(value) && value.every(isFtuePhase);
}

function isAccountMethod(value: unknown): value is AuthMethod | null {
  return (
    value === null ||
    (typeof value === "string" && AUTH_METHODS.has(value as AuthMethod))
  );
}

function isOrganizationDetails(value: unknown): value is OrganizationDetails {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.slug === "string"
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isBooleanState(
  value: Record<string, unknown>
): value is Record<BooleanStateKey, boolean> & Record<string, unknown> {
  return BOOLEAN_STATE_KEYS.every((key) => typeof value[key] === "boolean");
}

const DEFAULT_FIRST_ORGANIZATION = {
  name: "AcmeCo",
  slug: "acmeco",
} satisfies OrganizationDetails;

const GUIDED_FTUE_STORAGE_PREFIX = "closedloop.prototype.web-master.ftue";
// 2 since ISS-8345 renamed every persisted phase spelling (`complete` ->
// `dashboard_available`, `next` -> `account`, and seven more). A v1 snapshot
// carries the retired vocabulary, so admitting it here would pass the version
// gate and then fail phase validation — which reads as a corrupt snapshot and
// silently drops the reader back at welcome. Rejecting it by version is the
// designed reset path, and keeps one payload shape per version number.
//
// 3 since ISS-12363 made an unset sync policy `null`. A v2 snapshot carries the
// old seeded default `full` for a reader who never chose, and reading it under
// the new meaning would record a choice nobody made and skip the sync step.
const GUIDED_FTUE_STORAGE_VERSION = 3;
const MAX_PERSISTED_INVITES = 100;
const LEGACY_SYNC_INSIGHTS = "insights";
const LEGACY_SYNC_LOCAL = "local";

// Derived from the wizard's own phase record rather than re-enumerated: a
// prototype-local list would be a second answer to "which phases does the
// wizard screen" and would have to be updated in lockstep with the canonical
// one, which is the duplication ISS-8345 exists to remove.
//
// `dashboard_available` is added back because this set answers a WIDER question
// than the record does. The record says which phases the wizard RENDERS; this
// says which phases a snapshot may legitimately SIT at, and the flow rests at
// `dashboard_available` with the modal closed. Adding it is what kept dropping
// it from `WIZARD_RENDERS_PHASE` off the storage-migration path (ISS-8345).
//
// That is also the standing hazard: this set decides SNAPSHOT VALIDITY, so
// narrowing it retroactively invalidates every stored snapshot sitting at a
// phase that left — the silent drop back to welcome that
// `GUIDED_FTUE_STORAGE_VERSION` exists to prevent. Shrinking the ACCEPTED set is
// a storage migration: bump the version with it.
//
// What this adds ON TOP of the wizard's phases is stated as an exhaustive
// record rather than as inline literals, because `Set<FtuePhase>` accepts any
// SUBSET of the union: a third `FtuePhase` disjunct would compile here and then
// be rejected at runtime as a corrupt snapshot, which is the silent narrowing
// the paragraph above warns about. `satisfies Record<Exclude<...>, true>` turns
// that into a `tsc` failure at the moment the union grows.
const NON_WIZARD_FTUE_PHASES = {
  [OnboardingPhase.DashboardAvailable]: true,
} as const satisfies Record<Exclude<FtuePhase, WizardPhase>, true>;

const FTUE_PHASE_SET: ReadonlySet<FtuePhase> = new Set<FtuePhase>([
  ...WIZARD_PHASES,
  ...(Object.keys(NON_WIZARD_FTUE_PHASES) as Exclude<FtuePhase, WizardPhase>[]),
]);

const AUTH_METHODS = new Set<AuthMethod>(["github", "google", "email"]);

const BOOLEAN_STATE_KEYS = [
  "accountCreated",
  "accountSkipped",
  "dashboardTourCompleted",
  "desktopAppDownloaded",
  "githubConnected",
  "organizationChosen",
  "resumingInvite",
  "teamInvited",
] as const;

type BooleanStateKey = (typeof BOOLEAN_STATE_KEYS)[number];
