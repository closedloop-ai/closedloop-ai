"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * Whether client-side PostHog flag reads are being suppressed for the current
 * viewer, and which keys escape that suppression (ISS-7477).
 *
 * The suppression lives in this package, next to `useFeatureFlag`, because that
 * hook — not the `@repo/app` feature-flag port — is where every client flag read
 * on the web surface actually converges. The port adapter in
 * `apps/app/lib/app-core-adapters.tsx` is implemented ON TOP of `useFeatureFlag`,
 * and seventeen further modules (the sidebar, the command palette, and
 * `FeatureFlagRouteGate` among them) call it directly. Decorating only the port
 * would have left the nav and the route gates resolving internal-only flags.
 */
export type CustomerViewState = {
  /**
   * When true, every non-exempt flag resolves to a SETTLED `false` — not to
   * "unresolved". A data-read surface keying its request off a flag has to be
   * able to tell those apart (FEA-1626), and under customer view the answer is
   * genuinely decided rather than still in flight.
   */
  active: boolean;
  /**
   * Keys that keep resolving normally while `active`. Exactly one kind of key
   * belongs here: whatever gates the control that turns suppression back OFF.
   * Suppress that and the switch vanishes along with the view it switched away
   * from, stranding the viewer in the customer view with no way back.
   */
  exemptFlagKeys: ReadonlySet<string>;
};

/**
 * Reads the current suppression state. Defaults to inactive, so a tree with no
 * `CustomerViewProvider` — Storybook, a unit test, the marketing app — resolves
 * flags exactly as it does today.
 */
export function useCustomerViewState(): CustomerViewState {
  return useContext(CustomerViewContext);
}

/**
 * Whether `flagKey` should resolve to a settled `false` under `state`. Pure and
 * exported so the decision can be tested without a React tree.
 *
 * Deny-by-default is what makes the feature maintenance-free — a flag created
 * tomorrow is suppressed the day it exists — and it carries one standing
 * assumption worth meeting here rather than discovering later: EVERY FLAG IS A
 * GRANT. A flag whose enabled state expresses a RESTRICTION instead (a
 * kill-switch, a step-up-auth requirement, a maintenance lockout) would be
 * silently LIFTED by the customer view rather than shown. Every flag in the
 * project today is an additive UI-visibility gate and nothing in the types holds
 * them to it, so a restriction-shaped flag has to be exempted here — or not be a
 * flag.
 */
export function suppressesFeatureFlag(
  state: CustomerViewState,
  flagKey: string
): boolean {
  return state.active && !state.exemptFlagKeys.has(flagKey);
}

export function CustomerViewProvider({
  active,
  exemptFlagKeys,
  children,
}: {
  active: boolean;
  /**
   * Pass a module-level constant: the array identity is a memo dependency, so an
   * inline literal would rebuild the set on every render.
   */
  exemptFlagKeys?: readonly string[];
  children: ReactNode;
}) {
  const value = useMemo<CustomerViewState>(
    () => ({ active, exemptFlagKeys: new Set(exemptFlagKeys ?? []) }),
    [active, exemptFlagKeys]
  );

  return (
    <CustomerViewContext.Provider value={value}>
      {children}
    </CustomerViewContext.Provider>
  );
}

const INACTIVE_CUSTOMER_VIEW: CustomerViewState = {
  active: false,
  exemptFlagKeys: new Set(),
};

const CustomerViewContext = createContext<CustomerViewState>(
  INACTIVE_CUSTOMER_VIEW
);
