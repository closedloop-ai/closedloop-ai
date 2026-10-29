import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { DEV_MODE_FLAG_KEY } from "@repo/api/src/types/dev-mode-flag";
import { parseFeatureFlagOverrides } from "@repo/api/src/types/feature-flag-overrides";
import { isStaffEmail } from "@repo/api/src/types/staff-email";
import type { DesktopMainFeatureFlagAssignmentStore } from "./desktop-feature-flag-assignment.js";

/**
 * ISS-12048 — Dev Tools flag overrides for main's OWN flag reads.
 *
 * The renderer sends this device's overrides over IPC, but main decides for
 * itself whether they apply: the signed-in account must carry `dev-mode` in
 * main's own assignment store AND have a staff email in main's own identity
 * fetch, both for the account currently signed in. The renderer's claim of Dev
 * Mode is never an input, so a compromised or confused renderer cannot unlock a
 * flag for a customer. Restriction flags never reach the stored overrides
 * (`parseFeatureFlagOverrides` drops them), so no override can loosen
 * proof-of-possession, signing, or compute selection.
 *
 * Everything resets on an account boundary, before the new account's identity
 * is known, so one account's overrides and checked keys never apply to the next.
 */
export type DesktopMainDevMode = {
  /** Point at an account; clears synchronously, then checks its identity. */
  resolveFor(subject: string | null): Promise<void>;
  /** Store the renderer's overrides after validating them. */
  setRendererOverrides(payload: unknown): void;
  /** Main's own verdict: staff email plus `dev-mode` for the current account. */
  isEligible(): boolean;
  /** The override for a key, ignoring eligibility (callers check it first). */
  overrideFor(key: string): boolean | undefined;
  /** Note a key main checked while eligible; notifies on a new key only. */
  recordChecked(key: string): void;
  readChecked(): string[];
  /** Fires when a key is first recorded. */
  subscribeChecked(listener: () => void): () => void;
  /** Fires when the overrides or the identity half of eligibility change. */
  subscribeVerdicts(listener: () => void): () => void;
};

/** Generous for main's handful of gates, and a hard stop for anything else. */
const MAX_CHECKED_KEYS = 200;
const IDENTITY_RETRY_MS = 5000;

export function createDesktopMainDevMode(deps: {
  assignment: Pick<DesktopMainFeatureFlagAssignmentStore, "read" | "isEnabled">;
  fetchIdentity: () => Promise<DesktopIdentity | null>;
}): DesktopMainDevMode {
  let generation = 0;
  let currentSubject: string | null = null;
  let staffSubject: string | null = null;
  let identityResolved = false;
  let identityInFlight: Promise<void> | null = null;
  let nextIdentityRetryAt = 0;
  let overrides: Readonly<Record<string, boolean>> = parseFeatureFlagOverrides(
    {}
  );
  let checked = new Set<string>();
  const checkedListeners = new Set<() => void>();
  const verdictListeners = new Set<() => void>();

  const notify = (listeners: Set<() => void>): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A consumer's own failure must not strand the other listeners.
      }
    }
  };

  const refreshIdentity = (subject: string, at: number): Promise<void> => {
    nextIdentityRetryAt = Date.now() + IDENTITY_RETRY_MS;
    const pending = Promise.resolve()
      .then(() => deps.fetchIdentity())
      .then((identity) => {
        if (at !== generation || identity?.userId !== subject) {
          return;
        }
        identityResolved = true;
        if (isStaffEmail(identity.email)) {
          staffSubject = subject;
          notify(verdictListeners);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (identityInFlight === pending) {
          identityInFlight = null;
        }
      });
    identityInFlight = pending;
    return pending;
  };

  const retryIdentityIfNeeded = (): void => {
    const subject = currentSubject;
    if (
      !subject ||
      identityResolved ||
      identityInFlight ||
      Date.now() < nextIdentityRetryAt ||
      deps.assignment.read().subject !== subject ||
      !deps.assignment.isEnabled(DEV_MODE_FLAG_KEY)
    ) {
      return;
    }
    refreshIdentity(subject, generation).catch(() => undefined);
  };

  return {
    async resolveFor(subject) {
      generation += 1;
      const at = generation;
      currentSubject = subject;
      staffSubject = null;
      identityResolved = false;
      identityInFlight = null;
      nextIdentityRetryAt = 0;
      overrides = parseFeatureFlagOverrides({});
      checked = new Set();
      notify(verdictListeners);
      notify(checkedListeners);
      if (!subject) {
        return;
      }
      await refreshIdentity(subject, at);
    },
    setRendererOverrides(payload) {
      overrides = parseFeatureFlagOverrides(payload);
      retryIdentityIfNeeded();
      notify(verdictListeners);
    },
    isEligible() {
      retryIdentityIfNeeded();
      return (
        staffSubject !== null &&
        deps.assignment.read().subject === staffSubject &&
        deps.assignment.isEnabled(DEV_MODE_FLAG_KEY)
      );
    },
    overrideFor(key) {
      return Object.hasOwn(overrides, key) ? overrides[key] : undefined;
    },
    recordChecked(key) {
      if (checked.has(key) || checked.size >= MAX_CHECKED_KEYS) {
        return;
      }
      checked.add(key);
      notify(checkedListeners);
    },
    readChecked() {
      return [...checked];
    },
    subscribeChecked(listener) {
      checkedListeners.add(listener);
      return () => {
        checkedListeners.delete(listener);
      };
    },
    subscribeVerdicts(listener) {
      verdictListeners.add(listener);
      return () => {
        verdictListeners.delete(listener);
      };
    },
  };
}

/**
 * The process-wide instance, published by the composition root next to the
 * assignment store. Unset means no overrides and nothing recorded, so a suite
 * that never wires it reads exactly the assignment.
 */
let publishedDevMode: DesktopMainDevMode | null = null;

export function publishDesktopMainDevMode(
  devMode: DesktopMainDevMode | null
): void {
  publishedDevMode = devMode;
}

/**
 * The override `isDesktopMainFeatureFlagEnabled` applies, recording the key as
 * checked. `undefined` (and nothing recorded) unless main's own eligibility
 * check passes.
 */
export function resolveDesktopMainDevModeOverride(
  key: string
): boolean | undefined {
  if (!publishedDevMode?.isEligible()) {
    return undefined;
  }
  publishedDevMode.recordChecked(key);
  return publishedDevMode.overrideFor(key);
}

/** The IPC entry point for the renderer's overrides. */
export function setDesktopMainFeatureFlagOverrides(payload: unknown): void {
  publishedDevMode?.setRendererOverrides(payload);
}

/** The keys main checked while eligible, for the renderer's overlay. */
export function readDesktopMainCheckedFeatureFlags(): string[] {
  return publishedDevMode?.isEligible() ? publishedDevMode.readChecked() : [];
}

/** Subscribe to override and eligibility changes; a no-op when unwired. */
export function subscribeToDesktopMainDevModeVerdicts(
  listener: () => void
): () => void {
  return publishedDevMode?.subscribeVerdicts(listener) ?? (() => undefined);
}
