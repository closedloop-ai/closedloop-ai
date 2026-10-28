import { CustomerViewProvider } from "@repo/analytics/customer-view";
import { FeatureFlagOverridesProvider } from "@repo/analytics/feature-flag-overrides";
import {
  FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
  parseFeatureFlagOverrides,
} from "@repo/api/src/types/feature-flag-overrides";
import { useDevToolsSettings } from "@repo/app/shared/dev-tools/hooks/use-dev-tools-settings";
import {
  registerMountedCheckedFeatureFlag,
  setPersistentCheckedFeatureFlags,
} from "@repo/app/shared/dev-tools/lib/checked-feature-flags-store";
import { DEV_MODE_EXEMPT_FLAG_KEYS } from "@repo/app/shared/feature-flags/dev-mode/dev-mode-contract";
import {
  DevModeEligibility,
  DevModeProvider,
  useDevMode,
  useIsDevModeOn,
} from "@repo/app/shared/feature-flags/dev-mode/dev-mode-provider";
import { type ReactNode, useEffect } from "react";
import { z } from "zod";
import { useDesktopAuthOptional } from "../shared-agent-sessions/desktop-auth-provider";
import {
  DesktopStaffStatus,
  useDesktopStaffStatus,
} from "../shared-agent-sessions/use-desktop-staff-status";

/**
 * ISS-12048 — Desktop Dev Mode, the desktop twin of `WebDevModeProvider`.
 *
 * Eligibility matches web: a signed-in user with a staff email (from the
 * identity main fetches for the signed-in account) while `dev-mode` is rolled
 * out. Signed out, or with no auth provider at all, is ineligible: no Dev Mode,
 * no overlay, no customer view. The on/off choice is the shared per-device
 * `DevModeProvider` storage, default on, as on web.
 */
export function DesktopDevModeProvider({
  isRolledOut,
  children,
}: {
  /** `dev-mode` from the signed-in account's PostHog assignment. */
  isRolledOut: boolean;
  children: ReactNode;
}) {
  const auth = useDesktopAuthOptional();
  const staffStatus = useDesktopStaffStatus(auth?.state ?? null);

  return (
    <DevModeProvider
      eligibility={ELIGIBILITY_BY_STAFF_STATUS[staffStatus]}
      isRolledOut={isRolledOut}
    >
      {children}
    </DevModeProvider>
  );
}

/**
 * What Dev Mode does to flag reads below it, as on web: Dev Mode off is the
 * customer view (internal-only flags suppressed, Daveth 2026-10-06), and Dev
 * Mode on lets this device's overrides apply and records each checked key for
 * the overlay. It also hands the overrides to main and feeds main's checked
 * keys into the same record.
 */
export function DesktopDevModeFlagScope({ children }: { children: ReactNode }) {
  const { isDevModeEnabled } = useDevMode();
  const isDevModeOn = useIsDevModeOn();
  useMainFeatureFlagOverridesSync();
  useMainCheckedFeatureFlags();

  return (
    <CustomerViewProvider
      active={!isDevModeEnabled}
      exemptFlagKeys={DEV_MODE_EXEMPT_FLAG_KEYS}
    >
      <FeatureFlagOverridesProvider
        active={isDevModeOn}
        onFlagRead={recordRendererCheckedFlag}
      >
        {children}
      </FeatureFlagOverridesProvider>
    </CustomerViewProvider>
  );
}

/**
 * Sends this device's overrides to main while Dev Mode is on, and an empty
 * record otherwise, so turning Dev Mode off or signing out withdraws them from
 * main too. Main re-checks eligibility itself before applying any of them.
 */
function useMainFeatureFlagOverridesSync(): void {
  const isDevModeOn = useIsDevModeOn();
  const { settings } = useDevToolsSettings(FEATURE_FLAG_OVERRIDES_STORAGE_KEY);

  useEffect(() => {
    const send = window.desktopApi?.setFeatureFlagOverrides;
    if (!send) {
      return;
    }
    send(
      isDevModeOn ? parseFeatureFlagOverrides(settings) : NO_OVERRIDES
    ).catch(() => {
      // Best effort: main reads its assignment unchanged without them.
    });
  }, [isDevModeOn, settings]);
}

/**
 * Feeds main's session-wide checked keys into the overlay while Dev Mode is on.
 */
function useMainCheckedFeatureFlags(): void {
  const isDevModeOn = useIsDevModeOn();

  useEffect(() => {
    const api = window.desktopApi;
    const read = api?.getMainCheckedFeatureFlags;
    if (!(isDevModeOn && read)) {
      return;
    }
    let cancelled = false;
    const pull = () => {
      read()
        .then((payload) => {
          if (cancelled) {
            return;
          }
          setPersistentCheckedFeatureFlags(parseCheckedKeys(payload));
        })
        .catch(() => {
          // Best effort: the overlay lists the renderer's keys without these.
        });
    };
    pull();
    const unsubscribeMain = api.onMainCheckedFeatureFlagsChanged?.(pull);
    return () => {
      cancelled = true;
      unsubscribeMain?.();
      setPersistentCheckedFeatureFlags([]);
    };
  }, [isDevModeOn]);
}

function recordRendererCheckedFlag(flag: string): () => void {
  return registerMountedCheckedFeatureFlag(flag);
}

function parseCheckedKeys(payload: unknown): readonly string[] {
  const parsed = checkedKeysSchema.safeParse(payload);
  return parsed.success ? parsed.data : [];
}

const ELIGIBILITY_BY_STAFF_STATUS: Record<
  DesktopStaffStatus,
  DevModeEligibility
> = {
  [DesktopStaffStatus.Unknown]: DevModeEligibility.Unknown,
  [DesktopStaffStatus.Staff]: DevModeEligibility.Eligible,
  [DesktopStaffStatus.NotStaff]: DevModeEligibility.Ineligible,
};

const NO_OVERRIDES: Readonly<Record<string, boolean>> = Object.freeze({});

const checkedKeysSchema = z.array(z.string().min(1).max(200)).max(200);
