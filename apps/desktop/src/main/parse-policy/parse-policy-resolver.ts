/**
 * ISS-12552 (PRD-800 "Rollout"): the one place Desktop reads the
 * `attribution-evidence-policy` flag, and the controller that turns its answer
 * into this process's parse policy. Everything else receives the policy as
 * data (`effective-parse-policy.ts`, the worker request, the import and rebuild
 * invokes, the db host's init and its `parsePolicy.set` op).
 *
 * The flag is a company group flag: the Desktop assignment endpoint evaluates
 * it for the signed-in account's organization. Only an ASSIGNED answer that
 * the endpoint marks as the organization's is an answer; a Dev Mode override
 * takes precedence over it. Anything else (pending, signed out, a transport
 * failure, a payload without the key) holds the persisted verdict, which
 * starts off, so a blip never flips the policy and a Desktop that has never
 * had an answer parses as before PRD-800. Only organization answers are
 * persisted, so the persisted verdict is always the last real one, and an on
 * verdict is kept with its organization: signed in to another organization,
 * the policy is off until that organization answers.
 */
import { ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY } from "@repo/api/src/types/attribution-evidence-policy-flag";
import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import {
  readDesktopMainFeatureFlagAssignment,
  subscribeToDesktopMainFeatureFlagAssignment,
} from "../auth/desktop-feature-flag-assignment.js";
import { resolveDesktopMainDevModeOverride } from "../auth/desktop-feature-flag-dev-mode.js";
import type { SettingsStore } from "../settings/settings-store.js";
import { noteParsePolicyFlipForOwners } from "./attribution-owners-derived.js";
import {
  effectiveParsePolicy,
  setEffectiveParsePolicy,
} from "./effective-parse-policy.js";
import {
  type ParsePolicy,
  parsePolicyFor,
  sameParsePolicy,
} from "./parse-policy.js";

/** A Dev Mode override of the flag, or `undefined` when none is set. */
export function readAttributionEvidenceOverride(): boolean | undefined {
  return resolveDesktopMainDevModeOverride(
    ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY
  );
}

/** The organization's answer, or `undefined` when there is none to act on. */
export function readAttributionEvidenceVerdict(): boolean | undefined {
  const assignment = readDesktopMainFeatureFlagAssignment();
  // A value the service did not mark as the organization's (an API that
  // predates the marker, or has rolled back) is the per-person evaluation of
  // a group flag, which reads off for everyone: no answer.
  if (
    assignment?.delivery !== FeatureAssignmentDelivery.Assigned ||
    !Object.hasOwn(assignment.flags, ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY) ||
    !assignment.organizationEvaluated?.includes(
      ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY
    )
  ) {
    return;
  }
  return assignment.flags[ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY] === true;
}

export type ParsePolicyControllerDeps = {
  /**
   * The persisted verdict (`attributionEvidenceParsePolicyOrganizationId`):
   * the organization the last answer turned the policy on for, or null for
   * off, the default.
   */
  readPersisted: () => string | null;
  /** Called only for an organization answer: its organization if on, else null. */
  persist: (onForOrganization: string | null) => void;
  /** The signed-in account's organization, or null when there is none. */
  readOrganization: () => string | null;
  /** The organization's answer. */
  readVerdict: () => boolean | undefined;
  /** A Dev Mode override, which wins over the answer and is never persisted. */
  readOverride?: () => boolean | undefined;
  /** Subscribe to verdict changes; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** A settled change of policy: push it to the db host and rebuild once. */
  onFlip: (policy: ParsePolicy) => void;
  /** How long a changed verdict must hold; 0 flips at once. */
  holdMs?: number;
  /** Runs `run` after `ms`; returns the cancel. */
  schedule?: (run: () => void, ms: number) => () => void;
};

/**
 * ISS-12552: every flip re-derives the whole corpus
 * and re-sends it, so a verdict that changes is acted on only once it has held
 * for this long. A minimum hold rather than two consecutive answers, because
 * answers arrive only when the assignment is refetched: a hold settles on a
 * clock, where waiting for a second answer could leave a real change unapplied
 * until some later refetch.
 */
export const PARSE_POLICY_FLIP_HOLD_MS = 30_000;

export type ParsePolicyController = {
  /** Adopt the persisted verdict, then follow the flag. */
  start: () => void;
  dispose: () => void;
};

export function createParsePolicyController(
  deps: ParsePolicyControllerDeps
): ParsePolicyController {
  const holdMs = deps.holdMs ?? PARSE_POLICY_FLIP_HOLD_MS;
  const schedule = deps.schedule ?? scheduleUnref;
  let unsubscribe: (() => void) | null = null;
  const readOverride = deps.readOverride ?? noOverride;
  let cancelHold: (() => void) | null = null;
  const differs = (attributionEvidence: boolean): boolean =>
    !sameParsePolicy(
      parsePolicyFor(attributionEvidence),
      effectiveParsePolicy()
    );
  // An on verdict holds signed out, and only for its own organization.
  const persistedVerdict = (): boolean => {
    const onFor = deps.readPersisted();
    const organization = deps.readOrganization();
    return onFor !== null && (organization === null || organization === onFor);
  };
  // With no override and no answer the policy follows the persisted verdict:
  // after an override clears, that is the last real answer.
  const target = (): { attributionEvidence: boolean; answered: boolean } => {
    const answered = readOverride() ?? deps.readVerdict();
    return answered === undefined
      ? { attributionEvidence: persistedVerdict(), answered: false }
      : { attributionEvidence: answered, answered: true };
  };
  // ISS-12552: persist the organization's answer, never an override.
  // An answer the policy is still holding toward is persisted when it flips.
  const recordAnswer = (): void => {
    const answer = deps.readVerdict();
    const organization = deps.readOrganization();
    if (answer === undefined || organization === null) {
      return;
    }
    const onFor = answer ? organization : null;
    if (onFor === deps.readPersisted()) {
      return;
    }
    if (readOverride() === undefined && differs(answer)) {
      return;
    }
    deps.persist(onFor);
  };
  const flipIfStillChanged = (): void => {
    cancelHold = null;
    const next = parsePolicyFor(target().attributionEvidence);
    if (sameParsePolicy(next, effectiveParsePolicy())) {
      return;
    }
    noteParsePolicyFlipForOwners();
    setEffectiveParsePolicy(next);
    recordAnswer();
    deps.onFlip(next);
  };
  const reconcile = (): void => {
    recordAnswer();
    const next = target();
    if (!differs(next.attributionEvidence)) {
      // No answer is not a return: a pending hold re-reads when it ends.
      if (next.answered) {
        cancelHold?.();
        cancelHold = null;
      }
      return;
    }
    // Falling back to off with no answer (an organization change, or an
    // override cleared while signed out) is not held: off is how Desktop
    // parses before any answer.
    const resetToOff = !(next.answered || next.attributionEvidence);
    if (holdMs <= 0 || resetToOff) {
      cancelHold?.();
      flipIfStillChanged();
      return;
    }
    cancelHold ??= schedule(flipIfStillChanged, holdMs);
  };
  return {
    start() {
      setEffectiveParsePolicy(parsePolicyFor(persistedVerdict()));
      unsubscribe ??= deps.subscribe(reconcile);
      reconcile();
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      cancelHold?.();
      cancelHold = null;
    },
  };
}

function noOverride(): undefined {
  return;
}

function scheduleUnref(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * The runtime that owns the db host and the rebuild is created after the
 * controller starts, so a flip reaches it through this hub.
 */
const flipListeners = new Set<(policy: ParsePolicy) => void>();

export function notifyParsePolicyFlip(policy: ParsePolicy): void {
  for (const listener of flipListeners) {
    try {
      listener(policy);
    } catch {
      // A subscriber's own failure must not strand the others.
    }
  }
}

export function subscribeParsePolicyFlips(
  listener: (policy: ParsePolicy) => void
): () => void {
  flipListeners.add(listener);
  return () => {
    flipListeners.delete(listener);
  };
}

/** Waits before re-pushing a policy the db host did not confirm. */
const PUSH_RETRY_DELAYS_MS: readonly number[] = [1000, 5000];

/**
 * ISS-12552: push a settled flip to the db host and confirm it took. The push
 * answers the revision the host now stamps; anything other than the revision
 * of the policy pushed (a rejection while the child stays up, or a stale
 * answer) is retried after each delay in turn, then given up with the reason
 * logged. Bounded: at most one attempt more than there are delays, and a newer
 * flip supersedes an older one's remaining retries. Resolves whether the host
 * confirmed the policy.
 */
export function createParsePolicyPusher(deps: {
  push: (policy: ParsePolicy) => Promise<unknown>;
  expectedRevision: (policy: ParsePolicy) => number;
  log: (message: string) => void;
  retryDelaysMs?: readonly number[];
  wait?: (ms: number) => Promise<void>;
}): (policy: ParsePolicy) => Promise<boolean> {
  const delays = deps.retryDelaysMs ?? PUSH_RETRY_DELAYS_MS;
  const wait = deps.wait ?? waitMs;
  let generation = 0;
  return async (policy) => {
    generation += 1;
    const at = generation;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (attempt > 0) {
        await wait(delays[attempt - 1] ?? 0);
        if (at !== generation) {
          return false;
        }
      }
      if (await pushedAndConfirmed(deps, policy)) {
        return true;
      }
    }
    deps.log(
      `parse policy push to the db host not confirmed after ${delays.length + 1} attempts`
    );
    return false;
  };
}

async function pushedAndConfirmed(
  deps: {
    push: (policy: ParsePolicy) => Promise<unknown>;
    expectedRevision: (policy: ParsePolicy) => number;
    log: (message: string) => void;
  },
  policy: ParsePolicy
): Promise<boolean> {
  try {
    const revision = await deps.push(policy);
    if (revision === deps.expectedRevision(policy)) {
      return true;
    }
    deps.log(
      `parse policy push answered revision ${String(revision)}, not ${deps.expectedRevision(policy)}`
    );
  } catch (error) {
    deps.log(
      `parse policy push to the db host failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return false;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The controller as the composition root starts it (`desktop-services.ts`):
 * the persisted verdict in settings, the signed-in account's organization, the
 * published assignment store, and a settled flip handed to the agent runtime
 * through {@link notifyParsePolicyFlip}.
 */
export function startDesktopParsePolicyController(deps: {
  settings: Pick<
    SettingsStore,
    | "getAttributionEvidenceParsePolicyOrganizationId"
    | "setAttributionEvidenceParsePolicyOrganizationId"
  >;
  readOrganization: () => string | null;
}): ParsePolicyController {
  const controller = createParsePolicyController({
    readPersisted: () =>
      deps.settings.getAttributionEvidenceParsePolicyOrganizationId(),
    persist: (onFor) =>
      deps.settings.setAttributionEvidenceParsePolicyOrganizationId(onFor),
    readOrganization: deps.readOrganization,
    readVerdict: readAttributionEvidenceVerdict,
    readOverride: readAttributionEvidenceOverride,
    subscribe: subscribeToDesktopMainFeatureFlagAssignment,
    onFlip: notifyParsePolicyFlip,
  });
  controller.start();
  return controller;
}
