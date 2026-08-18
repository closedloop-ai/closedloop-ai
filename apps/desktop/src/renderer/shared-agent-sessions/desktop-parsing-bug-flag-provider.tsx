import { ParsingBugFlagProvider } from "@repo/app/agents/data-source/parsing-bug-flag-provider";
import { isStaffEmail } from "@repo/app/shared/auth/staff-email";
import { type ReactNode, useEffect, useState } from "react";
import { useDesktopAuth } from "./desktop-auth-provider";
import { useOnlineStatus } from "./use-online-status";

/**
 * FEA-4347: desktop surface adapter that resolves whether the signed-in desktop
 * user is Closedloop staff (by `@closedloop.ai` email) and injects that into the
 * shared {@link ParsingBugFlagProvider}, which gates the internal "Flag as
 * parsing/data bug" affordance in the session-trace comment composer. Customers
 * resolve to `false` and never see it.
 *
 * The email lives in the display identity fetched over the main-process bridge
 * (`getDesktopIdentity`) — the same source the Settings → Account tab uses. It
 * is fetched only while authenticated; a bridge-absent test stub, a signed-out
 * session, or a fetch failure all leave staff-ness `false`, so the affordance
 * stays hidden by default (fail-safe).
 */
export function DesktopParsingBugFlagProvider({
  children,
}: {
  children: ReactNode;
}) {
  const canFlagParsingBug = useDesktopStaffFlag();
  return (
    <ParsingBugFlagProvider canFlagParsingBug={canFlagParsingBug}>
      {children}
    </ParsingBugFlagProvider>
  );
}

/**
 * Resolve staff-ness from the signed-in desktop identity's email. Returns
 * `false` until an authenticated identity whose `userId` matches the current
 * authed user resolves with a staff email.
 */
function useDesktopStaffFlag(): boolean {
  const { state } = useDesktopAuth();
  const isOnline = useOnlineStatus();
  // Track the user the staff verdict belongs to, not just a bare boolean.
  // `DesktopAppCoreModeStack` preserves this subtree across auth changes, so a
  // staff→customer switch must not leave a stale `true` visible: we reset to
  // false the instant `authedUserId` changes and only re-trust the flag once a
  // fetched identity's own `userId` confirms it belongs to the new account.
  const [staffForUserId, setStaffForUserId] = useState<string | null>(null);
  const authedUserId = state.status === "authenticated" ? state.userId : null;

  // `isOnline` is a dependency so a session that starts offline (or whose first
  // identity request fails/times out) re-runs the lookup when connectivity
  // returns. `DesktopAppCoreModeStack` preserves these children across
  // online/offline flips, so without this a staff user who booted offline would
  // keep losing the checkbox until a reload or auth change. The bridge fetch is
  // idempotent, so re-running it on the online transition is safe.
  useEffect(() => {
    // Clear any prior verdict up front so the checkbox can't linger from the
    // previous account while this lookup is in flight.
    setStaffForUserId(null);

    const fetchIdentity = window.desktopApi?.getDesktopIdentity;
    if (!(authedUserId && isOnline && fetchIdentity)) {
      return;
    }
    let cancelled = false;
    fetchIdentity()
      .then((identity) => {
        // Correlate the response to the account it was requested for: a late
        // reply for a prior user must not grant staff to the current one.
        if (
          !cancelled &&
          identity?.userId === authedUserId &&
          isStaffEmail(identity.email)
        ) {
          setStaffForUserId(authedUserId);
        }
      })
      .catch(() => {
        // Fail-safe: leave the flag off.
      });
    return () => {
      cancelled = true;
    };
  }, [authedUserId, isOnline]);

  return authedUserId !== null && staffForUserId === authedUserId;
}
