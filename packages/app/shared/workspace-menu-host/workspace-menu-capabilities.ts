import {
  DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES,
  type WorkspaceMenuCapabilities,
  type WorkspaceMenuCapability,
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuEntryId,
  WorkspaceMenuProjectionStatus,
  workspaceMenuCapabilityError,
  workspaceMenuCapabilityPending,
  workspaceMenuCapabilityReady,
  workspaceMenuCapabilityUnavailable,
} from "@repo/api/src/types/workspace-menu";

/**
 * The capability policy both hosts derive from, in ONE place.
 *
 * Written once rather than per adapter because the two would otherwise be a pair
 * of hand-maintained tables that agree until one is edited — and what they would
 * disagree about is which entries a host can reach at all: organization
 * switching under the 2026-09-03 operator ruling, and Members under ISS-8368,
 * whose Clerk embed cannot mount in the desktop renderer. Both are hard product
 * boundaries, so they get a single owner and a test, not a convention.
 */

export type WebWorkspaceMenuCapabilityInput = {
  /**
   * The Desktop download entry's own outcome. `Ready` only when a URL actually
   * resolved — a failed release read is an `Error`, never a missing entry, so the
   * menu can say the download could not be reached instead of pretending web has
   * no such feature.
   */
  download: WorkspaceMenuCapability;
};

export type DesktopWorkspaceMenuCapabilityInput = {
  /** A signed-out desktop still shows the menu — it is the way back in. */
  isGuest: boolean;
};

export function buildWebWorkspaceMenuCapabilities(
  input: WebWorkspaceMenuCapabilityInput
): WorkspaceMenuCapabilities {
  return {
    [WorkspaceMenuEntryId.Settings]: workspaceMenuCapabilityReady(),
    [WorkspaceMenuEntryId.Members]: workspaceMenuCapabilityReady(),
    // ISS-10362. Web is NOT getting a second invite path: its Members entry
    // above already reads "Invite and manage members" and reaches Clerk's
    // roster, which does everything this row does and more. Absent by
    // construction, exactly like Diagnostics below — a host offering the
    // capability through a different entry still does not offer THIS entry.
    [WorkspaceMenuEntryId.Invite]: workspaceMenuCapabilityUnavailable(
      WorkspaceMenuCapabilityReason.NotSupportedOnHost
    ),
    [WorkspaceMenuEntryId.DownloadDesktop]: input.download,
    [WorkspaceMenuEntryId.SwitchWorkspace]: workspaceMenuCapabilityReady(),
    [WorkspaceMenuEntryId.CreateWorkspace]: workspaceMenuCapabilityReady(),
    // ISS-10006 gave web a Diagnostics page, behind `diagnostics-complete-surface`.
    // This is the CLOSED default; the web adapter overrides it to `Ready` once
    // that key resolves on, and leaves it here when the route would 404.
    [WorkspaceMenuEntryId.Diagnostics]: workspaceMenuCapabilityUnavailable(
      WorkspaceMenuCapabilityReason.NotSupportedOnHost
    ),
    [WorkspaceMenuEntryId.LogOut]: workspaceMenuCapabilityReady(),
    // The web menu only renders for a signed-in actor, so the guest door never
    // applies there.
    [WorkspaceMenuEntryId.CreateAccount]: workspaceMenuCapabilityUnavailable(
      WorkspaceMenuCapabilityReason.AlreadySignedIn
    ),
    [WorkspaceMenuEntryId.SignIn]: workspaceMenuCapabilityUnavailable(
      WorkspaceMenuCapabilityReason.AlreadySignedIn
    ),
  };
}

export function buildDesktopWorkspaceMenuCapabilities(
  input: DesktopWorkspaceMenuCapabilityInput
): WorkspaceMenuCapabilities {
  const needsIdentity = workspaceMenuCapabilityUnavailable(
    WorkspaceMenuCapabilityReason.SignedOut
  );

  const capabilities: WorkspaceMenuCapabilities = {
    // Settings stays reachable for a guest on purpose: Settings → Account is a
    // signed-out desktop user's way IN, and this menu is its only link site in
    // the renderer (ISS-5112).
    [WorkspaceMenuEntryId.Settings]: workspaceMenuCapabilityReady(),
    // The omitted-set loop below overwrites this, so the ternary looks dead —
    // keep it anyway. It is the guest gate, and it is the ONLY thing standing
    // between a signed-out desktop guest and a live "Invite and manage members"
    // link if Members ever comes off `DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES`.
    // No test can hold this: while Members is omitted the loop answers
    // `Unavailable` either way, so an assertion here passes with the gate
    // deleted. Removing the entry from the omitted set must be the ONLY edit a
    // future revert needs (marisolashgrove, #6719).
    [WorkspaceMenuEntryId.Members]: input.isGuest
      ? needsIdentity
      : workspaceMenuCapabilityReady(),
    // ISS-10362. Desktop's invite home, because Members is unreachable here:
    // its panel body is Clerk's `<OrganizationProfile>` and the renderer mounts
    // no Clerk provider. This entry needs no roster, so it clears that bar.
    //
    // A guest has no organization to invite anyone INTO — the dialog mints
    // invitations against an org id — so the entry is absent rather than
    // offering a control that cannot do its job (ISS-5112). The guest's door out
    // of that state is the CreateAccount row in this same menu.
    [WorkspaceMenuEntryId.Invite]: input.isGuest
      ? needsIdentity
      : workspaceMenuCapabilityReady(),
    [WorkspaceMenuEntryId.DownloadDesktop]: workspaceMenuCapabilityReady(),
    [WorkspaceMenuEntryId.SwitchWorkspace]: workspaceMenuCapabilityReady(),
    [WorkspaceMenuEntryId.CreateWorkspace]: workspaceMenuCapabilityReady(),
    // Diagnostics has no other link site in the renderer and no Electron
    // app-menu entry, so a guest keeps it too.
    [WorkspaceMenuEntryId.Diagnostics]: workspaceMenuCapabilityReady(),
    [WorkspaceMenuEntryId.LogOut]: input.isGuest
      ? needsIdentity
      : workspaceMenuCapabilityReady(),
    [WorkspaceMenuEntryId.CreateAccount]: input.isGuest
      ? workspaceMenuCapabilityReady()
      : workspaceMenuCapabilityUnavailable(
          WorkspaceMenuCapabilityReason.AlreadySignedIn
        ),
    [WorkspaceMenuEntryId.SignIn]: input.isGuest
      ? workspaceMenuCapabilityReady()
      : workspaceMenuCapabilityUnavailable(
          WorkspaceMenuCapabilityReason.AlreadySignedIn
        ),
  };

  // DERIVED, never re-listed. The omitted set has one owner
  // (`DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES`); naming those entries a second
  // time here is exactly how this builder and that array would come to disagree
  // about whether Desktop can reach organization switching.
  for (const entry of DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES) {
    capabilities[entry] = workspaceMenuCapabilityUnavailable(
      WorkspaceMenuCapabilityReason.NotSupportedOnHost
    );
  }

  return capabilities;
}

/**
 * The standings in which there is no settled workspace to act on.
 *
 * An entry whose action needs an ORGANIZATION ID — minting an invitation,
 * activating a different workspace, mounting Clerk's create-organization embed —
 * has no operand in either of these, so it must not be projected `Ready` into a
 * body that is only ever `ProjectedWorkspaceMenu`, which mounts none of those
 * controllers.
 */
export const STANDINGS_WITHOUT_A_WORKSPACE: readonly WorkspaceMenuProjectionStatus[] =
  Object.freeze([
    WorkspaceMenuProjectionStatus.Pending,
    WorkspaceMenuProjectionStatus.Error,
  ]);

/**
 * The standings in which there is no session to end.
 *
 * DELIBERATELY NOT the set above. `Error` is a session that EXISTS and went
 * wrong — ending it is the recovery ISS-11400 exists to keep reachable, so Log
 * out survives there. `Pending` is the one that does not, and only on a host
 * whose Pending covers mid-sign-in: desktop's `OpeningBrowser`,
 * `AwaitingRedirect` and `Exchanging` are a person waiting on a browser tab with
 * no session yet, where "Log out" names an action the row cannot take — clicking
 * it cancels the sign-in. Web's `Pending` is the opposite (a real session with
 * Clerk still hydrating), so web must NOT narrow Log out and does not.
 */
export const STANDINGS_WITHOUT_A_SESSION: readonly WorkspaceMenuProjectionStatus[] =
  Object.freeze([WorkspaceMenuProjectionStatus.Pending]);

/**
 * An entry's capability, narrowed to the standing the menu is actually
 * rendering in.
 *
 * DOWNGRADE-ONLY, and that is the whole contract: a standing can withhold an
 * entry the host offers, never grant one it does not, so the host policy above
 * stays the single owner of "can this surface reach this entry at all". The
 * `Pending`/`Error` split is preserved rather than collapsed — "the read has not
 * landed" and "the read failed" are different things to a user, which is why the
 * capability union has four members instead of a boolean.
 *
 * This exists because the same defect kept reaching review under different
 * entries (ISS-11400): a capability marked renderable in a body that mounts no
 * controller for it, which is a menu claiming an action it cannot take. One
 * helper, so the answer is spelled once rather than per adapter.
 */
export function narrowCapabilityToStanding(
  capability: WorkspaceMenuCapability,
  standing: WorkspaceMenuProjectionStatus,
  withholdIn: readonly WorkspaceMenuProjectionStatus[]
): WorkspaceMenuCapability {
  if (!withholdIn.includes(standing)) {
    return capability;
  }
  if (standing === WorkspaceMenuProjectionStatus.Pending) {
    return workspaceMenuCapabilityPending();
  }
  return workspaceMenuCapabilityError(WorkspaceMenuCapabilityReason.ReadFailed);
}
