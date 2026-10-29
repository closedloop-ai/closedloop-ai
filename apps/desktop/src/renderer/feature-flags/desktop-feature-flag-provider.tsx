import {
  suppressesFeatureFlag,
  useCustomerViewState,
} from "@repo/analytics/customer-view";
import { useFeatureFlagOverride } from "@repo/analytics/feature-flag-overrides";
import { DEV_MODE_FLAG_KEY } from "@repo/api/src/types/dev-mode-flag";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  DesktopDevModeFlagScope,
  DesktopDevModeProvider,
} from "./desktop-dev-mode-provider";
import {
  type DesktopPostHogFlagAssignment,
  useDesktopPostHogFlagAssignment,
} from "./desktop-posthog-flag-assignment";

/**
 * Desktop shell adapter for the `@repo/app` feature-flag port (FEA-1514).
 *
 * ONE SOURCE (ISS-8753, operator direction 2026-09-01): the signed-in user's
 * PostHog assignment — the same per-user evaluation the web app resolves from,
 * fetched server-side and delivered over the IPC bridge
 * ({@link useDesktopPostHogFlagAssignment}). There is no second path and no
 * switch between paths, so a gate cannot resolve one way on web and another on
 * desktop.
 *
 * FAIL-CLOSED IN EVERY BUILD, dev included. Nothing here reads `app.isPackaged`:
 * the local Labs registry this provider used to consult also carried a dev
 * fail-OPEN for any key it did not declare, and that branch is gone with it. An
 * unknown key, an unresolved assignment, a signed-out session (beyond the
 * ISS-11945 anonymous keys) and an offline one are all `false`.
 *
 * ENABLED AND RESOLVED STAY SEPARATE. `useFeatureFlagResolved` reports
 * SETTLED-ness, never enabled-ness — every terminal non-answer (signed out,
 * offline, bridge absent, transport failure) settles CLOSED rather than staying
 * pending, so a gated route is held dark through the resolution window and is
 * never stranded in it.
 *
 * DEV MODE (ISS-12048) sits between the assignment and the consumers, as on
 * web: off is the customer view (every non-exempt key settles closed), on lets
 * Dev Tools overrides win over the assignment through the same
 * `@repo/analytics` precedence web uses. An overridden or suppressed key reads
 * resolved, since its value no longer waits on the assignment. `dev-mode`
 * itself is read straight from the assignment, so neither can move it.
 */
export function DesktopFeatureFlagProvider({
  children,
}: {
  children: ReactNode;
}) {
  const posthogAssignment = useDesktopPostHogFlagAssignment();

  const adapter = useMemo(
    () => createDesktopFeatureFlagAdapter(posthogAssignment),
    [posthogAssignment]
  );

  return (
    <DesktopFeatureFlagsResolvedContext value={posthogAssignment.resolved}>
      <DesktopDevModeProvider
        isRolledOut={posthogAssignment.flags[DEV_MODE_FLAG_KEY] === true}
      >
        <DesktopDevModeFlagScope>
          <FeatureFlagAdapterProvider adapter={adapter}>
            {children}
          </FeatureFlagAdapterProvider>
        </DesktopDevModeFlagScope>
      </DesktopDevModeProvider>
    </DesktopFeatureFlagsResolvedContext>
  );
}

/**
 * ISS-5037 — whether the flag answers have actually arrived.
 *
 * Defaults to `false` (and to `false` with no provider, e.g. a unit test that
 * mounts a bare subtree), so a caller that withholds a one-way decision until
 * this is true degrades to withholding it — never to committing it early.
 */
export function useDesktopFeatureFlagsResolved(): boolean {
  return useContext(DesktopFeatureFlagsResolvedContext);
}

const DesktopFeatureFlagsResolvedContext = createContext(false);

/**
 * The port adapter over one assignment snapshot. Its members are hooks, called
 * at each flag consumer's render position, which is why the Dev Mode scope
 * above sits between the adapter and the consumers. Customer-view suppression
 * is decided before the override, matching `useFeatureFlag` on web.
 */
function createDesktopFeatureFlagAdapter(
  posthogAssignment: DesktopPostHogFlagAssignment
): FeatureFlagAdapter {
  return {
    useFeatureFlagEnabled(key) {
      const customerView = useCustomerViewState();
      const override = useFeatureFlagOverride(key);
      if (suppressesFeatureFlag(customerView, key)) {
        return false;
      }
      return override ?? posthogAssignment.flags[key] === true;
    },
    useFeatureFlagResolved(key) {
      const customerView = useCustomerViewState();
      const override = useFeatureFlagOverride(key);
      return (
        suppressesFeatureFlag(customerView, key) ||
        override !== undefined ||
        posthogAssignment.resolved
      );
    },
    // ISS-12048: the overlay's production value, the assignment untouched by
    // overrides or the customer view. The API's desktop flag route already
    // pins a preview's snapshot, so this is the snapshot value there.
    useFeatureFlagProductionValue(key) {
      return posthogAssignment.resolved
        ? posthogAssignment.flags[key] === true
        : undefined;
    },
  };
}
