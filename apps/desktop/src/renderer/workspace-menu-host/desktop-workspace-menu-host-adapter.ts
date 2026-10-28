import {
  type WorkspaceMenuCapabilities,
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuEntryId,
  WorkspaceMenuHostId,
  type WorkspaceMenuProjection,
  WorkspaceMenuProjectionStatus,
} from "@repo/api/src/types/workspace-menu";
import {
  buildDesktopWorkspaceMenuCapabilities,
  narrowCapabilityToStanding,
  STANDINGS_WITHOUT_A_SESSION,
  STANDINGS_WITHOUT_A_WORKSPACE,
} from "@repo/app/shared/workspace-menu-host/workspace-menu-capabilities";
import type { WorkspaceMenuHostAdapter } from "@repo/app/shared/workspace-menu-host/workspace-menu-host-adapter";
import { DesktopAuthStatus } from "../../shared/contracts";

/**
 * ISS-8363 (PRD-691) — the desktop renderer's implementation of the
 * workspace-menu port.
 *
 * SINGLE-ORG BY CONSTRUCTION. The 2026-09-03 operator ruling removes Switch
 * workspace, Create a workspace, and Download desktop app from Desktop
 * completely, and this adapter is where that becomes structural rather than
 * conventional: it supplies no `switchWorkspace` and no `createWorkspaceSlot`,
 * and `buildDesktopWorkspaceMenuCapabilities` marks every entry in
 * `DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES` `Unavailable` — those three, plus
 * Members, which is on that list for a capability gap rather than the ruling
 * (ISS-8368). The array is the inventory; this file keeps no count of it. The
 * renderer has no organization-list or `setActive` code path to reach even if a
 * future edit tried — the same guarantee `WEB_SETTINGS_HOST_CAPABILITIES` gives
 * the web local-device read.
 */

export type DesktopWorkspaceMenuIdentity = {
  organizationName: string | null;
  userName: string | null;
  email: string | null;
  /**
   * ISS-11465 — the organization logo and user avatar the menu renders. `null`
   * when the server did not send one (an older build, an org with no logo, or a
   * Clerk read that failed), which is the case the menu's initial-letter
   * fallback exists for.
   */
  organizationImageUrl: string | null;
  userImageUrl: string | null;
};

export type DesktopWorkspaceMenuHostInput = {
  /** Settled identity, or null while the desktop session is still resolving. */
  identity: DesktopWorkspaceMenuIdentity | null;
  /** The main process's auth state — the authority on what "settled" means. */
  authStatus: DesktopAuthStatus;
  /** Whether the identity FETCH resolved. Only meaningful when authenticated. */
  isResolved: boolean;
  /** Where this build routes Diagnostics. */
  diagnosticsHref: string;
  signOut: () => Promise<void>;
  requestAccount?: () => void;
  requestSignIn?: () => void;
};

/**
 * What each auth status means for the menu, exhaustive by type so a new
 * {@link DesktopAuthStatus} fails `tsc` here until someone decides what the menu
 * SHOWS for it.
 *
 * `useDesktopIdentity` resolves to `{identity: null, isResolved: true}` for
 * EVERY non-authenticated status — signed out, mid-sign-in, and lapsed alike —
 * so `isResolved` cannot tell those apart on its own. Reading settlement off it
 * turns "opening your browser to sign in" into "Account unavailable"; reading it
 * off identity nullability instead strands a lapsed session on "Loading"
 * forever. Only the status separates them, so only the status decides.
 */
const PROJECTION_FOR_AUTH_STATUS: Record<
  DesktopAuthStatus,
  | typeof WorkspaceMenuProjectionStatus.Guest
  | typeof WorkspaceMenuProjectionStatus.Pending
  | typeof WorkspaceMenuProjectionStatus.Error
  /** Authenticated defers to the identity read rather than deciding here. */
  | "defer"
> = {
  [DesktopAuthStatus.Loading]: WorkspaceMenuProjectionStatus.Pending,
  [DesktopAuthStatus.SignedOut]: WorkspaceMenuProjectionStatus.Guest,
  [DesktopAuthStatus.OpeningBrowser]: WorkspaceMenuProjectionStatus.Pending,
  [DesktopAuthStatus.AwaitingRedirect]: WorkspaceMenuProjectionStatus.Pending,
  [DesktopAuthStatus.Exchanging]: WorkspaceMenuProjectionStatus.Pending,
  [DesktopAuthStatus.Authenticated]: "defer",
  // Credentials were cleared. A settled failure the user must act on, and NOT a
  // guest: `canOfferAccount` excludes it so a returning user is not told to
  // create the account they already have.
  [DesktopAuthStatus.RefreshFailed]: WorkspaceMenuProjectionStatus.Error,
};

/** A signed-out desktop still shows the menu — it is the way back in. */
export function isDesktopWorkspaceMenuGuest(
  authStatus: DesktopAuthStatus
): boolean {
  return authStatus === DesktopAuthStatus.SignedOut;
}

/**
 * The desktop workspace identity, as the menu's one-workspace list.
 *
 * `slug` is null because desktop URLs carry no organization slug; the menu joins
 * org-relative Settings routes through `useOrgPath()`, which on this host is the
 * navigation adapter's `identityOrgPath` — the identity function.
 */
export function toDesktopWorkspaceMenuProjection(
  input: DesktopWorkspaceMenuHostInput
): WorkspaceMenuProjection {
  const status = desktopWorkspaceMenuProjectionStatus({
    authStatus: input.authStatus,
    hasIdentity: input.identity !== null,
    isResolved: input.isResolved,
  });
  // Desktop IS the desktop app: there is nothing to download on ANY standing,
  // and the entry is `Unavailable` on this host besides.
  if (status === WorkspaceMenuProjectionStatus.Guest) {
    return { status: WorkspaceMenuProjectionStatus.Guest, downloadUrl: null };
  }
  if (status === WorkspaceMenuProjectionStatus.Pending) {
    return { status: WorkspaceMenuProjectionStatus.Pending, downloadUrl: null };
  }
  // ONE producer of the read-failed projection, reached from two places: the
  // standing itself, and the narrowing below that `tsc` cannot derive from it.
  const readFailed = {
    status: WorkspaceMenuProjectionStatus.Error,
    reason: WorkspaceMenuCapabilityReason.ReadFailed,
    downloadUrl: null,
  } as const;
  if (status === WorkspaceMenuProjectionStatus.Error) {
    return readFailed;
  }
  if (!input.identity) {
    // Unreachable: `Ready` is the only status left, and the helper returns it
    // only for `hasIdentity`, computed from this same object one call above. Kept
    // because `tsc` cannot carry that through the helper's return type, and a
    // cast would hide the very nullability the standing turns on.
    return readFailed;
  }

  const workspace = {
    id: "desktop-workspace",
    name: input.identity.organizationName ?? "Workspace",
    slug: null,
    // ISS-11465: web reads these from its Clerk hooks; desktop has no Clerk
    // client, so they arrive on the identity payload. `null` keeps the menu's
    // initial-letter fallback, which is what shipped here unconditionally before.
    imageUrl: input.identity.organizationImageUrl,
  };

  return {
    status: WorkspaceMenuProjectionStatus.Ready,
    activeWorkspace: workspace,
    workspaces: [workspace],
    actor: {
      name: input.identity.userName,
      email: input.identity.email,
      imageUrl: input.identity.userImageUrl,
    },
    // Desktop IS the desktop app. There is nothing to download, and the entry is
    // absent rather than carrying a dead URL.
    downloadUrl: null,
  };
}

export function toDesktopWorkspaceMenuCapabilities(
  input: DesktopWorkspaceMenuHostInput
): WorkspaceMenuCapabilities {
  const fromHostPolicy = buildDesktopWorkspaceMenuCapabilities({
    isGuest: isDesktopWorkspaceMenuGuest(input.authStatus),
  });
  const standing = desktopWorkspaceMenuProjectionStatus({
    authStatus: input.authStatus,
    hasIdentity: input.identity !== null,
    isResolved: input.isResolved,
  });
  return {
    ...fromHostPolicy,
    // AFTER the spread so the standing always wins — the host policy above
    // answers only "can Desktop reach this entry at all".
    //
    // The two entries whose ACTION this host's non-Ready standings cannot carry,
    // and they take DIFFERENT sets: the invite dialog needs an organization id,
    // which neither Pending nor Error has, while Log out needs only a session to
    // end — Error has one and that is the recovery this ticket exists to keep,
    // so only Pending withholds it. `isDesktopWorkspaceMenuGuest` is true for
    // `SignedOut` alone, so a guest who clicks sign in moves to
    // `OpeningBrowser`/`AwaitingRedirect`/`Exchanging`, and "Log out" there names
    // an action the row cannot take: `signOut()` cancels the sign-in run.
    [WorkspaceMenuEntryId.Invite]: narrowCapabilityToStanding(
      fromHostPolicy[WorkspaceMenuEntryId.Invite],
      standing,
      STANDINGS_WITHOUT_A_WORKSPACE
    ),
    [WorkspaceMenuEntryId.LogOut]: narrowCapabilityToStanding(
      fromHostPolicy[WorkspaceMenuEntryId.LogOut],
      standing,
      STANDINGS_WITHOUT_A_SESSION
    ),
  };
}

export function createDesktopWorkspaceMenuHostAdapter(
  input: DesktopWorkspaceMenuHostInput
): WorkspaceMenuHostAdapter {
  return {
    host: WorkspaceMenuHostId.Desktop,
    // The desktop reads are all in-memory session state, so neither depends on
    // the menu being open the way web's paginated and networked reads do.
    useWorkspaceMenuProjection: () => toDesktopWorkspaceMenuProjection(input),
    useWorkspaceMenuCapabilities: () =>
      toDesktopWorkspaceMenuCapabilities(input),
    diagnosticsHref: input.diagnosticsHref,
    // No `switchWorkspace` and no `createWorkspaceSlot`, deliberately: this host
    // has no organization-switching path, and their capabilities are Unavailable.
    requestAccount: input.requestAccount,
    requestSignIn: input.requestSignIn,
    signOut: input.signOut,
  };
}

/**
 * WHICH standing the desktop workspace menu is in, given the three facts that
 * decide it. Exported because a SECOND reader needs the same answer: the
 * sidebar footer's invite row (ISS-11247).
 *
 * The footer surrenders that row to the workspace menu on the
 * `workspace-menu-invite-entry` key alone, while the menu's own invite row and
 * its dialog exist only inside `ReadyWorkspaceMenu`. Those are two different
 * conditions, so with the key on and this answer anything but `Ready` — a
 * failed `GET /desktop/identity`, which `useDesktopIdentity` settles as
 * `{identity: null, isResolved: true}` — a signed-in desktop user had no invite
 * affordance anywhere in the shell.
 *
 * The footer therefore asks THIS function rather than re-deriving "can the menu
 * show it": a second copy of the standing is exactly how the two gates came to
 * disagree in the first place.
 *
 * `hasIdentity` rather than the identity itself, because the standing turns on
 * nullability alone and a caller that holds no `DesktopWorkspaceMenuIdentity`
 * should not have to invent one to ask.
 */
export function desktopWorkspaceMenuProjectionStatus({
  authStatus,
  hasIdentity,
  isResolved,
}: {
  authStatus: DesktopAuthStatus;
  hasIdentity: boolean;
  isResolved: boolean;
}): WorkspaceMenuProjectionStatus {
  const fromStatus = PROJECTION_FOR_AUTH_STATUS[authStatus];
  if (fromStatus !== "defer") {
    return fromStatus;
  }
  // Authenticated: the identity fetch decides.
  if (!isResolved) {
    return WorkspaceMenuProjectionStatus.Pending;
  }
  // Resolved with nothing to show is a failed read, not a guest: the fetch was
  // supposed to produce an identity and did not.
  return hasIdentity
    ? WorkspaceMenuProjectionStatus.Ready
    : WorkspaceMenuProjectionStatus.Error;
}
