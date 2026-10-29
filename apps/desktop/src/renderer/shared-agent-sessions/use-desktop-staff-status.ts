import { isStaffEmail } from "@repo/api/src/types/staff-email";
import { useEffect, useState } from "react";
import { DesktopAuthStatus } from "../../shared/contracts";
import type { DesktopAuthState } from "../types/desktop-api";
import { useOnlineStatus } from "./use-online-status";

/**
 * Whether the signed-in desktop user is Closedloop staff, by the email in the
 * display identity fetched over the main-process bridge (`getDesktopIdentity`).
 *
 * `Unknown` is kept apart from `NotStaff` (ISS-12048): Dev Mode needs to tell
 * "identity not answered yet" from "answered, not staff", the same distinction
 * `DevModeEligibility` draws on web. A consumer that only needs a yes (the
 * FEA-4347 parsing-bug affordance) reads `Staff` and treats the rest as no.
 */
export const DesktopStaffStatus = {
  Unknown: "unknown",
  Staff: "staff",
  NotStaff: "not-staff",
} as const;
export type DesktopStaffStatus =
  (typeof DesktopStaffStatus)[keyof typeof DesktopStaffStatus];

type StaffVerdict = { userId: string; isStaff: boolean };

/**
 * Takes the auth state rather than reading it, so each caller keeps its own
 * provider contract (the parsing-bug provider requires one; the Dev Mode
 * provider tolerates its absence as signed out).
 */
export function useDesktopStaffStatus(
  authState: DesktopAuthState | null
): DesktopStaffStatus {
  const isOnline = useOnlineStatus();
  // `|| null`: an authenticated state with no user id (a partial bridge
  // payload) is not an account, so it must not be compared as one.
  const authedUserId =
    (authState?.status === DesktopAuthStatus.Authenticated &&
      authState.userId) ||
    null;
  // The verdict carries the user it belongs to, so an account switch can never
  // read the previous account's answer, even before the new lookup lands.
  const [verdict, setVerdict] = useState<StaffVerdict | null>(null);

  // `isOnline` is a dependency so a session that starts offline, or whose
  // first lookup fails, retries when connectivity returns. The bridge fetch is
  // idempotent.
  useEffect(() => {
    setVerdict(null);
    const fetchIdentity = window.desktopApi?.getDesktopIdentity;
    if (!(authedUserId && isOnline && fetchIdentity)) {
      return;
    }
    let cancelled = false;
    fetchIdentity()
      .then((identity) => {
        // Correlate the reply to the account it was requested for.
        if (!cancelled && identity?.userId === authedUserId) {
          setVerdict({
            userId: authedUserId,
            isStaff: isStaffEmail(identity.email),
          });
        }
      })
      .catch(() => {
        // Fail-safe: the status stays unknown, which grants nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [authedUserId, isOnline]);

  if (authedUserId === null) {
    return isAuthPending(authState)
      ? DesktopStaffStatus.Unknown
      : DesktopStaffStatus.NotStaff;
  }
  if (!verdict || verdict.userId !== authedUserId) {
    return DesktopStaffStatus.Unknown;
  }
  return verdict.isStaff
    ? DesktopStaffStatus.Staff
    : DesktopStaffStatus.NotStaff;
}

/** Still restoring the stored session: nobody is known to be signed out yet. */
function isAuthPending(authState: DesktopAuthState | null): boolean {
  return authState?.status === DesktopAuthStatus.Loading;
}
