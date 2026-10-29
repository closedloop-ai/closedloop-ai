import { FirstOrgUserValue } from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";

/**
 * The client-held record of one onboarding attempt's analytics context
 * (PRD-736 §Identity): the per-flow-entry `flow_id`, when the flow started,
 * which steps were skipped, and the resolved `first_org_user` value.
 *
 * Shared across emit sites (the FSM consumer, the dialog host, CTA controls,
 * the tour) through module state rather than React context, because the flow
 * outlives any one mount — the blocking dialog closes before the tour runs.
 * `sessionStorage` backs it so a mid-flow reload (org switch, auth return)
 * keeps one attempt one `flow_id`; storage is a convenience, so every access
 * is guarded and the in-memory copy is the fallback.
 */
export type OnboardingFlowSession = {
  flowId: string;
  /**
   * Epoch ms when `onboarding_flow_started` was emitted, or `null` for a
   * session lazily minted mid-flow (a run that predates this instrumentation).
   * `null` means `duration_seconds` is unknowable and is omitted, never 0.
   */
  startedAtMs: number | null;
  /** Steps skipped in this flow, in skip order (`steps_skipped` on completion). */
  skippedSteps: readonly OnboardingPhase[];
  /** Resolved at the org step; absent until then (`unknown` on the wire). */
  firstOrgUser?: typeof FirstOrgUserValue.True | typeof FirstOrgUserValue.False;
};

const STORAGE_KEY = "closedloop.onboarding.flow-session";

let inMemorySession: OnboardingFlowSession | null = null;

export function readOnboardingFlowSession(): OnboardingFlowSession | null {
  const stored = readStoredSession();
  return stored ?? inMemorySession;
}

/** Mint a fresh session for a flow whose start this client just observed. */
export function startOnboardingFlowSession(
  nowMs: number
): OnboardingFlowSession {
  const session: OnboardingFlowSession = {
    flowId: globalThis.crypto.randomUUID(),
    skippedSteps: [],
    startedAtMs: nowMs,
  };
  writeSession(session);
  return session;
}

/**
 * The session for a flow already in progress: the stored one, or a lazily
 * minted one with no `startedAtMs` for a run that began before this client
 * could observe it.
 */
export function ensureOnboardingFlowSession(): OnboardingFlowSession {
  const existing = readOnboardingFlowSession();
  if (existing) {
    return existing;
  }
  const session: OnboardingFlowSession = {
    flowId: globalThis.crypto.randomUUID(),
    skippedSteps: [],
    startedAtMs: null,
  };
  writeSession(session);
  return session;
}

export function recordOnboardingStepSkipped(step: OnboardingPhase): void {
  const session = ensureOnboardingFlowSession();
  if (session.skippedSteps.includes(step)) {
    return;
  }
  writeSession({ ...session, skippedSteps: [...session.skippedSteps, step] });
}

export function recordOnboardingFirstOrgUser(
  firstOrgUser: NonNullable<OnboardingFlowSession["firstOrgUser"]>
): void {
  writeSession({ ...ensureOnboardingFlowSession(), firstOrgUser });
}

/** End the attempt: return its record and clear the store. */
export function endOnboardingFlowSession(): OnboardingFlowSession {
  const session = ensureOnboardingFlowSession();
  inMemorySession = null;
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage is a convenience; the in-memory clear is the contract.
  }
  return session;
}

/** Test-only: clears both the in-memory copy and the stored one. */
export function resetOnboardingFlowSessionForTests(): void {
  inMemorySession = null;
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore: a test environment without storage has nothing to clear.
  }
}

function writeSession(session: OnboardingFlowSession): void {
  inMemorySession = session;
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage write failed (private window, quota); memory carries the flow.
  }
}

function readStoredSession(): OnboardingFlowSession | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isFlowSession(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

const ONBOARDING_PHASE_VALUES: ReadonlySet<string> = new Set(
  Object.values(OnboardingPhase)
);

/**
 * Valid-or-absent at the storage boundary: a stored record whose values fall
 * outside the closed vocabularies is dropped whole rather than replayed into
 * analytics properties, so `first_org_user` and `steps_skipped` can only ever
 * carry members of their enums.
 */
function isFlowSession(value: unknown): value is OnboardingFlowSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.flowId === "string" &&
    (record.startedAtMs === null || typeof record.startedAtMs === "number") &&
    Array.isArray(record.skippedSteps) &&
    record.skippedSteps.every(
      (step) => typeof step === "string" && ONBOARDING_PHASE_VALUES.has(step)
    ) &&
    (record.firstOrgUser === undefined ||
      record.firstOrgUser === FirstOrgUserValue.True ||
      record.firstOrgUser === FirstOrgUserValue.False)
  );
}
