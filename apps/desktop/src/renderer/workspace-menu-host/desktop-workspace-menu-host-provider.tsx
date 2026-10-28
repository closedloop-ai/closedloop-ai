import { getUserNamePart } from "@repo/app/shared/lib/user-utils";
import { WorkspaceMenuHostAdapterProvider } from "@repo/app/shared/workspace-menu-host/provider";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { isRendererDisplayableImageUrl } from "../../shared/content-security-policy";
import { useRequestGuestAccount } from "../components/onboarding/use-request-guest-account";
import { useRequestGuestSignIn } from "../components/onboarding/use-request-guest-sign-in";
import { hrefForNavId, NavId } from "../navigation/route-table";
import { useDesktopAuth } from "../shared-agent-sessions/desktop-auth-provider";
import { useDesktopIdentity } from "../shared-agent-sessions/use-desktop-identity";
import { createDesktopWorkspaceMenuHostAdapter } from "./desktop-workspace-menu-host-adapter";

/**
 * Mounts the desktop workspace-menu port.
 *
 * A COMPONENT, not a `createDesktopAppCoreStack` entry, because the identity,
 * guest, and sign-out reads it composes are hooks and that factory is a plain
 * function. It must therefore sit below `DesktopAuthProvider` in the tree.
 *
 * Mounted with the menu by the sidebar's `WorkspaceHeader` (ISS-8370 D7),
 * inside the sidebar's workspace chrome only.
 */
export function DesktopWorkspaceMenuHostProvider({
  children,
}: {
  children?: ReactNode;
}) {
  const { state, signOut } = useDesktopAuth();
  const { identity, isResolved } = useDesktopIdentity(
    state.status,
    state.userId
  );
  const requestAccount = useRequestGuestAccount();
  const requestSignIn = useRequestGuestSignIn();

  const adapter = useMemo(
    () =>
      createDesktopWorkspaceMenuHostAdapter({
        identity: identity
          ? {
              organizationName: identity.organizationName ?? null,
              // The canonical join, not a hand-rolled one: the desktop sidebar's
              // own account label already reads the name through this helper.
              userName: getUserNamePart(identity) || null,
              email: identity.email,
              // ISS-11465: both are optional on the wire (an older server omits
              // them), so absent normalizes to `null` and the menu keeps its
              // initial-letter fallback. A source this renderer's CSP would
              // refuse normalizes to `null` too — see
              // `toDisplayableImageUrl` below.
              organizationImageUrl: toDisplayableImageUrl(
                identity.organizationImageUrl
              ),
              userImageUrl: toDisplayableImageUrl(identity.userImageUrl),
            }
          : null,
        // The raw auth status, not a derived boolean. `useDesktopIdentity`
        // reports EVERY non-authenticated status as resolved-with-no-identity,
        // so guest, mid-sign-in and lapsed are indistinguishable downstream of
        // it; only the status separates them, and the adapter owns that map.
        authStatus: state.status,
        isResolved,
        diagnosticsHref: hrefForNavId(NavId.Diagnostics),
        signOut,
        // Absent while there is no guest run to resume, which drops the menu's
        // Create account row rather than leaving it inert (ISS-11480).
        requestAccount,
        requestSignIn,
      }),
    [identity, isResolved, requestAccount, requestSignIn, signOut, state.status]
  );

  return (
    <WorkspaceMenuHostAdapterProvider adapter={adapter}>
      {children}
    </WorkspaceMenuHostAdapterProvider>
  );
}

/**
 * The image URL the menu may actually render, or `null`.
 *
 * ISS-11465: an absent field (an older server) and a source the packaged
 * renderer's CSP refuses are the SAME case for this menu — there is no image to
 * show, so the initial-letter fallback stands. Rendering a refused source
 * instead leaves a mounted `<img>` that paints nothing and no fallback behind
 * it, which is the UI lying about what it has.
 */
function toDisplayableImageUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  return isRendererDisplayableImageUrl(url) ? url : null;
}
