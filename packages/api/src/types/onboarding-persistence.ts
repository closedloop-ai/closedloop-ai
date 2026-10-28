/**
 * @file onboarding-persistence.ts
 * @description Serialization and version-skew recovery for the onboarding
 * machine state (ISS-8349).
 *
 * The Zod schema lives HERE rather than beside the const objects in
 * `onboarding-phase.ts` so a bundle-sensitive `"use client"` surface can import
 * a phase constant without pulling Zod in — the split the repo's shared-constant
 * rule and PRD-689's "bundle-safe shared domain module" both ask for.
 *
 * Recovery contract (ISS-8349 acceptance): an unknown, malformed, or
 * cross-host-impossible persisted state degrades to a fresh run at
 * {@link OnboardingPhase.Welcome}. It never degrades INTO a completed state —
 * a failed read must not hand the user a Dashboard they never earned.
 */

import { z } from "zod";
import {
  AccountProvider,
  createInitialOnboardingState,
  isPhaseReachableOnHost,
  type OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
} from "./onboarding-phase.ts";
import { isReachableOnboardingState } from "./onboarding-reachability.ts";

/**
 * Bumped only when a persisted shape stops being readable by this parser. A
 * payload carrying any other version is treated as unreadable and recovers,
 * which is what makes a rollback safe in both directions.
 */
export const ONBOARDING_STATE_VERSION = 1;

const ONBOARDING_PHASE_VALUES = Object.values(OnboardingPhase) as [
  OnboardingPhase,
  ...OnboardingPhase[],
];
const ACCOUNT_PROVIDER_VALUES = Object.values(AccountProvider) as [
  AccountProvider,
  ...AccountProvider[],
];

const phaseSchema = z.enum(ONBOARDING_PHASE_VALUES);
const accountProviderSchema = z.enum(ACCOUNT_PROVIDER_VALUES);

/**
 * `.strict()` so a field this build does not know about is a failed read that
 * recovers, rather than a silently half-understood state. Every key a producer
 * can emit must be declared here.
 *
 * Exported because the guided transition endpoint (ISS-8375) validates the
 * state a client POSTs with THIS schema. The two boundaries want different
 * outcomes from the same parse — a stored payload recovers to a fresh run, a
 * posted one is rejected as a 400 — and that difference belongs to the caller.
 * Both must agree on which payloads are readable, so there is one schema.
 */
export const persistedOnboardingStateSchema = z
  .object({
    version: z.literal(ONBOARDING_STATE_VERSION),
    phase: phaseSchema,
    history: z.array(phaseSchema),
    /**
     * Optional with a `null` default so rows written before ISS-8347 still read,
     * and read conservatively: no stored account action is inferred from history.
     */
    accountProvider: accountProviderSchema.nullable().default(null),
    resuming: z.boolean(),
    /**
     * Optional with a `false` default so a payload written before this field
     * existed still reads, and reads as the conservative answer: an unknown
     * organization tail is treated as unrun, which routes a resumed account
     * step through organization setup rather than past it.
     */
    organizationEstablished: z.boolean().default(false),
  })
  .strict();

/** The serialized wire/storage shape. */
export type PersistedOnboardingState = z.infer<
  typeof persistedOnboardingStateSchema
>;

/**
 * Compile-time proof that the schema covers every persisted key. Adding a field
 * to {@link PersistedOnboardingState} without teaching the schema fails `tsc`
 * here instead of silently dropping the whole payload at runtime.
 */
const _persistedKeysCovered: Record<
  keyof PersistedOnboardingState,
  z.ZodTypeAny
> = persistedOnboardingStateSchema.shape;

/**
 * The READ-side twin of {@link persistedOnboardingStateSchema}: same shape,
 * same defaults, unknown keys STRIPPED rather than refused.
 *
 * Direction is the whole difference. The strict schema parses a payload this
 * build owns — a stored row, or a command a client POSTs — where a key it does
 * not know is a half-understood state to refuse. This one parses a SERVER that
 * may already be a deploy ahead, where the first additive field on this shape
 * would otherwise fail the ENTIRE read for every browser still holding the
 * previous bundle, and take the guided surface dark for the length of an
 * ordinary rolling deploy.
 *
 * STRIPPED, not passed through, and that is load-bearing: a read state is
 * handed on to {@link restoreOnboardingState}, which parses it STRICTLY again.
 * Passing the unknown key along would trade the failed read for an
 * `Unreadable` recovery — resetting a reader mid-run rather than ignoring a
 * field this build does not read yet.
 *
 * Derived from `.shape` rather than restated, which is what keeps the two
 * parsers on one shape: there is a single shape object and both read it, so a
 * field added to the strict schema reaches this one in the same edit and a
 * drifting copy is structurally unrepresentable. That sharing is the
 * guarantee — not {@link _persistedKeysCovered}, which checks the schema
 * against a type inferred from that same schema and so cannot fail for this
 * reason.
 */
export const readableOnboardingStateSchema = z.object(
  persistedOnboardingStateSchema.shape
);

/** Why a restore did not return the persisted state verbatim. */
export const OnboardingRestoreOutcome = {
  /** The payload parsed and is usable as-is. */
  Restored: "restored",
  /** Nothing was stored; this is a first run. */
  Absent: "absent",
  /** Unreadable: wrong version, unknown phase, or malformed. Recovered. */
  Unreadable: "unreadable",
  /** Readable but impossible on this host. Recovered. */
  UnreachableOnHost: "unreachable_on_host",
  /**
   * Shape-valid and host-valid, but not a state any run of the machine can
   * produce — `Ready` with no history, a history that skips an edge, a
   * `resuming` flag outside a resumed step. Recovered.
   */
  UnreachableState: "unreachable_state",
} as const;
export type OnboardingRestoreOutcome =
  (typeof OnboardingRestoreOutcome)[keyof typeof OnboardingRestoreOutcome];

export type OnboardingRestoreResult = {
  state: OnboardingMachineState;
  outcome: OnboardingRestoreOutcome;
};

/** Serialize for storage or transport. */
export function serializeOnboardingState(
  state: OnboardingMachineState
): PersistedOnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    phase: state.phase,
    history: [...state.history],
    accountProvider: state.accountProvider,
    resuming: state.resuming,
    organizationEstablished: state.organizationEstablished,
  };
}

/**
 * Restore a persisted state, or recover to a fresh run.
 *
 * `host` is required because a state is only valid on a surface that renders
 * its phase: a Web run persisted at {@link OnboardingPhase.DownloadDesktop} and
 * reopened on Desktop has no such screen, so it recovers rather than stranding
 * the user on a phase the host will never draw.
 */
export function restoreOnboardingState(
  raw: unknown,
  host: OnboardingHost
): OnboardingRestoreResult {
  if (raw === null || raw === undefined) {
    return {
      state: createInitialOnboardingState(),
      outcome: OnboardingRestoreOutcome.Absent,
    };
  }
  const parsed = persistedOnboardingStateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      state: createInitialOnboardingState(),
      outcome: OnboardingRestoreOutcome.Unreadable,
    };
  }
  const reachable =
    isPhaseReachableOnHost(parsed.data.phase, host) &&
    parsed.data.history.every((phase) => isPhaseReachableOnHost(phase, host));
  if (!reachable) {
    return {
      state: settledRunBehind(parsed.data) ?? createInitialOnboardingState(),
      outcome: OnboardingRestoreOutcome.UnreachableOnHost,
    };
  }
  const restored: OnboardingMachineState = {
    phase: parsed.data.phase,
    history: parsed.data.history,
    accountProvider: parsed.data.accountProvider,
    resuming: parsed.data.resuming,
    organizationEstablished: parsed.data.organizationEstablished,
  };
  // A payload can satisfy the schema and still describe a state no run can
  // produce. Restoring one bypasses the blocking flow it claims to be past, so
  // it takes the same safe recovery as an unreadable payload.
  if (!isReachableOnboardingState(restored)) {
    return {
      state: createInitialOnboardingState(),
      outcome: OnboardingRestoreOutcome.UnreachableState,
    };
  }
  return {
    state: restored,
    outcome: OnboardingRestoreOutcome.Restored,
  };
}

/**
 * Parse a JSON string from storage. A syntax error is just another unreadable
 * payload — it recovers rather than throwing into a render.
 */
export function restoreOnboardingStateFromJson(
  raw: string | null | undefined,
  host: OnboardingHost
): OnboardingRestoreResult {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return {
      state: createInitialOnboardingState(),
      outcome: OnboardingRestoreOutcome.Absent,
    };
  }
  try {
    return restoreOnboardingState(JSON.parse(raw), host);
  } catch {
    return {
      state: createInitialOnboardingState(),
      outcome: OnboardingRestoreOutcome.Unreadable,
    };
  }
}

/**
 * The settled run a RESUMED step was opened from, when the step itself is the
 * only thing this host cannot render (ISS-11249 review, @whitlockk).
 *
 * A resumed step can be host-specific — the sync election renders only on
 * Desktop — while the run it was resumed FROM is the ordinary settled run both
 * hosts share. Recovering such a payload to a fresh {@link OnboardingPhase.Welcome}
 * is what the general fallback would do, and for this shape it is wrong twice
 * over: it shows a reader who finished onboarding the blocking first-run
 * takeover, and because a recovered state is what that host then posts, its next
 * transition writes the fresh run over the other host's in-flight one and the
 * completed run is gone for good.
 *
 * Returning the Dashboard here does NOT breach the "never degrade INTO a
 * completed state" contract above, and the proof is in the payload rather than
 * in trust: {@link isReachableOnboardingState} admits `resuming` only with a
 * history of exactly `[DashboardAvailable]` and a resumable phase, so a state
 * of this shape can only have been produced by a run that had already reached
 * the Dashboard. The reader earned it; this is the one recovery that can say so
 * from the bytes.
 *
 * `undefined` for every other unreachable-on-host payload, which keeps the
 * conservative fresh-run recovery for the case that actually is unknown.
 */
function settledRunBehind(
  parsed: PersistedOnboardingState
): OnboardingMachineState | undefined {
  const resumed: OnboardingMachineState = {
    phase: parsed.phase,
    history: parsed.history,
    accountProvider: parsed.accountProvider,
    resuming: parsed.resuming,
    organizationEstablished: parsed.organizationEstablished,
  };
  // The whole guard: only a state the machine could actually have produced AS a
  // resumed step earns the Dashboard back. Anything else takes the fresh run.
  if (!(parsed.resuming && isReachableOnboardingState(resumed))) {
    return;
  }
  return {
    phase: OnboardingPhase.DashboardAvailable,
    history: [],
    accountProvider: parsed.accountProvider,
    resuming: false,
    organizationEstablished: parsed.organizationEstablished,
  };
}
