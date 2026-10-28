"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";
import { useLocalStorageState } from "../../hooks/use-local-storage-state";
import { booleanOrFallback } from "../../lib/local-storage-validators";
import { DEV_MODE_STORAGE_KEY } from "./dev-mode-contract";

/**
 * Whether this viewer may operate dev mode, with `Unknown` kept DISTINCT from
 * `Ineligible` rather than folded into it.
 *
 * Identity resolves asynchronously, so there is a real window on every load
 * where the answer is not known. Collapsing that window into "ineligible" is
 * what would show an internal viewer who chose the customer view the INTERNAL
 * view for the first frames of every page load — the one thing this feature
 * exists to prevent — because PostHog bootstraps flags from a cookie and can
 * answer before the identity does.
 */
export const DevModeEligibility = {
  Unknown: "unknown",
  Eligible: "eligible",
  Ineligible: "ineligible",
} as const;
export type DevModeEligibility =
  (typeof DevModeEligibility)[keyof typeof DevModeEligibility];

export type DevModeState = {
  /**
   * Whether the control may be shown AND operated: eligibility is strictly
   * `Eligible` — never the unresolved window — and the rollout gate is on.
   * Both inputs are resolved by the shell at its composition root (Clerk
   * identity and the rollout flag on web), so no client component decides its
   * own eligibility.
   */
  isDevModeAvailable: boolean;
  /**
   * ON (the default) means flags resolve exactly as they do today. OFF is the
   * customer view. A viewer KNOWN to be ineligible always reads ON, and so does
   * everyone once the rollout is off.
   */
  isDevModeEnabled: boolean;
  /** No-op unless available, so the state cannot be forced from a console. */
  setDevModeEnabled: (enabled: boolean) => void;
};

/**
 * Holds the internal viewer's dev-mode choice (ISS-7477). Surface-agnostic: it
 * knows nothing about PostHog or Labs config, only about the choice and who is
 * allowed to make it. The shell turns the choice into flag suppression at its
 * composition root.
 */
export function DevModeProvider({
  eligibility,
  isRolledOut,
  children,
}: {
  eligibility: DevModeEligibility;
  /**
   * The ISS-4779 rollout verdict for the dev-mode control, resolved by the
   * shell — PostHog on web, and whatever the desktop shell gates Labs on.
   *
   * It is a PROP rather than a flag read in here so this provider keeps knowing
   * nothing about PostHog or Labs config, and — the reason it is here at all
   * rather than in the control — so ONE value drives both whether the switch is
   * shown and whether the choice behind it is honoured. See
   * {@link resolveDevModeEnabled}.
   */
  isRolledOut: boolean;
  children: ReactNode;
}) {
  const [storedDevModeEnabled, setStoredDevModeEnabled] =
    useLocalStorageState<boolean>(
      DEV_MODE_STORAGE_KEY,
      true,
      booleanOrFallback
    );
  const isDevModeAvailable =
    eligibility === DevModeEligibility.Eligible && isRolledOut;

  const setDevModeEnabled = useCallback(
    (enabled: boolean) => {
      if (isDevModeAvailable) {
        setStoredDevModeEnabled(enabled);
      }
    },
    [isDevModeAvailable, setStoredDevModeEnabled]
  );

  const value = useMemo<DevModeState>(
    () => ({
      isDevModeAvailable,
      isDevModeEnabled: resolveDevModeEnabled(
        eligibility,
        isRolledOut,
        storedDevModeEnabled
      ),
      setDevModeEnabled,
    }),
    [
      eligibility,
      isRolledOut,
      isDevModeAvailable,
      storedDevModeEnabled,
      setDevModeEnabled,
    ]
  );

  return (
    <DevModeContext.Provider value={value}>{children}</DevModeContext.Provider>
  );
}

/**
 * The current dev-mode state. Outside a provider this reports "ineligible, dev
 * mode on" — nothing hidden, nothing suppressed — so a subtree that never wired
 * the provider behaves exactly as it did before ISS-7477.
 */
export function useDevMode(): DevModeState {
  return useContext(DevModeContext);
}

/**
 * ROLLED BACK BEATS STORED. The rollout gate hides the control, so if a stored
 * `false` still suppressed flags after the gate went off, the viewer would sit
 * in the customer view with every non-exempt flag forced off and the only switch
 * that turns it back on no longer rendered — recoverable solely by clearing
 * localStorage by hand. Reading the same verdict here is what makes that state
 * unreachable rather than merely unlikely: suppression now REQUIRES the rollout
 * that renders the way out.
 *
 * A viewer KNOWN to be ineligible is likewise pinned to normal evaluation
 * whatever storage holds: the customer view is an internal affordance, and a
 * customer who somehow acquired the key must not land in a mode nothing offers
 * them a way out of.
 *
 * While eligibility is still `Unknown` the STORED choice wins instead. That
 * choice is readable from the first render; identity is not. Deferring to
 * "ineligible" across that window would show the internal view to precisely the
 * viewer who asked not to see it. Honouring it early costs nothing in the other
 * direction — the key only gets written by someone eligible, and the customer
 * view can only ever REMOVE capability, so the worst case for a mislabelled
 * viewer is a briefly smaller product that corrects itself the moment identity
 * lands. It is not a trap either: that window ends in `Eligible` (the control
 * renders) or `Ineligible` (suppression lifts here).
 */
function resolveDevModeEnabled(
  eligibility: DevModeEligibility,
  isRolledOut: boolean,
  storedDevModeEnabled: boolean
): boolean {
  if (!isRolledOut) {
    return true;
  }
  if (eligibility === DevModeEligibility.Ineligible) {
    return true;
  }
  return storedDevModeEnabled;
}

const DEFAULT_DEV_MODE_STATE: DevModeState = {
  isDevModeAvailable: false,
  isDevModeEnabled: true,
  setDevModeEnabled: () => {
    // No provider, no choice to record.
  },
};

const DevModeContext = createContext<DevModeState>(DEFAULT_DEV_MODE_STATE);

/**
 * ISS-12048: whether Dev Mode is ON for a viewer allowed to operate it. Gates
 * the Dev Tools overlay and whether its flag overrides apply.
 *
 * Not `isDevModeEnabled` alone: that reads ON for every viewer who cannot
 * operate dev mode (customers, and everyone while the rollout is off), and the
 * overlay is an internal affordance.
 */
export function useIsDevModeOn(): boolean {
  const { isDevModeAvailable, isDevModeEnabled } = useDevMode();
  return isDevModeAvailable && isDevModeEnabled;
}
