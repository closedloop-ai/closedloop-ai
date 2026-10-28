import { SettingsPanelHost } from "./settings-panel.ts";

/**
 * ISS-8363 (PRD-691) — the workspace/account menu's contract vocabulary: which
 * entries exist, what each is called, and whether a given host offers one.
 *
 * Values only, no Zod: the menu is a `"use client"` surface that imports these
 * on every render, and dragging a parser into that bundle buys nothing. Same
 * contract as `settings-host-capabilities.ts`.
 *
 * Client-only today, but it lives here rather than in `packages/app` for the
 * same reason `settings-panel.ts` does: web and the desktop renderer both speak
 * it, and a host-neutral vocabulary cannot live inside one host's package.
 *
 * PRESENCE IS PROJECTED, NEVER INFERRED. Web and Desktop share one presentation
 * and hold two different item sets: what Desktop does not offer is absent
 * COMPLETELY, not disabled. {@link DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES} is
 * that inventory and its own docstring says why each entry is on it — naming
 * them a second time up here is how the two come to disagree. That absence is
 * carried as an
 * {@link WorkspaceMenuCapabilityStatus.Unavailable} value with a reason, never
 * as a missing adapter method, because a silently-absent method is
 * indistinguishable from a read that failed and the two must never render alike.
 */

export const WorkspaceMenuEntryId = {
  Settings: "settings",
  Members: "members",
  Invite: "invite",
  DownloadDesktop: "download-desktop",
  SwitchWorkspace: "switch-workspace",
  CreateWorkspace: "create-workspace",
  Diagnostics: "diagnostics",
  LogOut: "log-out",
  CreateAccount: "create-account",
  SignIn: "sign-in",
} as const;

export type WorkspaceMenuEntryId =
  (typeof WorkspaceMenuEntryId)[keyof typeof WorkspaceMenuEntryId];

/**
 * Whether the host offers an entry, kept distinct from why it does not.
 *
 * `Unavailable` is a settled "this host has no such thing" — Desktop and org
 * switching. `Error` is a decision that was supposed to resolve and did not —
 * the Desktop release lookup failing on web. `Pending` is neither: the read is
 * still in flight, and it must not borrow either verdict. None of the three may
 * render as a working control (PRD-692).
 *
 * `Pending` exists so a slow or paused optional read can hide its own entry
 * WITHOUT holding the whole menu on a loading trigger. Folding it into
 * `Unavailable` would claim the host lacks a feature it has.
 */
export const WorkspaceMenuCapabilityStatus = {
  Ready: "ready",
  /** The read that decides this entry has not settled. Transient, not a verdict. */
  Pending: "pending",
  Unavailable: "unavailable",
  Error: "error",
} as const;

export type WorkspaceMenuCapabilityStatus =
  (typeof WorkspaceMenuCapabilityStatus)[keyof typeof WorkspaceMenuCapabilityStatus];

/** Why an entry is not `Ready`. Host-derived; never carried on a wire. */
export const WorkspaceMenuCapabilityReason = {
  /** The host does not have this concept at all — Desktop and org switching. */
  NotSupportedOnHost: "not-supported-on-host",
  /** A read that should have resolved did not. */
  ReadFailed: "read-failed",
  /** The entry requires an identity and there is none. */
  SignedOut: "signed-out",
  /** The entry only makes sense signed out — the guest sign-in door. */
  AlreadySignedIn: "already-signed-in",
} as const;

export type WorkspaceMenuCapabilityReason =
  (typeof WorkspaceMenuCapabilityReason)[keyof typeof WorkspaceMenuCapabilityReason];

export type WorkspaceMenuCapability =
  | { status: typeof WorkspaceMenuCapabilityStatus.Ready }
  | { status: typeof WorkspaceMenuCapabilityStatus.Pending }
  | {
      status:
        | typeof WorkspaceMenuCapabilityStatus.Unavailable
        | typeof WorkspaceMenuCapabilityStatus.Error;
      reason: WorkspaceMenuCapabilityReason;
    };

export type WorkspaceMenuCapabilities = Record<
  WorkspaceMenuEntryId,
  WorkspaceMenuCapability
>;

/**
 * Entry copy. Exhaustive by type, so adding an entry id fails `tsc` here until
 * someone decides what it SAYS rather than shipping a blank row.
 *
 * "Create a workspace", not the prototype's "Create or join a workspace…": the
 * menu cannot join — joining happens during Clerk authentication — and a label
 * must not offer a capability the control does not have.
 */
export const WORKSPACE_MENU_ENTRY_LABEL: Record<WorkspaceMenuEntryId, string> =
  {
    [WorkspaceMenuEntryId.Settings]: "Settings",
    [WorkspaceMenuEntryId.Members]: "Invite and manage members",
    // ISS-10362. "Invite members", not "Invite and manage members": this entry
    // opens the invite dialog and reaches no roster, and a label must not offer
    // a capability the control does not have — the same rule that made
    // CreateWorkspace "Create a workspace" rather than the prototype's
    // "Create or join a workspace…".
    [WorkspaceMenuEntryId.Invite]: "Invite members",
    [WorkspaceMenuEntryId.DownloadDesktop]: "Download desktop app",
    [WorkspaceMenuEntryId.SwitchWorkspace]: "Switch workspace",
    [WorkspaceMenuEntryId.CreateWorkspace]: "Create a workspace",
    [WorkspaceMenuEntryId.Diagnostics]: "Diagnostics",
    [WorkspaceMenuEntryId.LogOut]: "Log out",
    [WorkspaceMenuEntryId.CreateAccount]: "Create account",
    // ISS-12475: a returning account's direct entry, alongside account creation.
    [WorkspaceMenuEntryId.SignIn]: "Sign in",
  };

/**
 * DERIVED from the exhaustive label map, never restated. A hand-written second
 * list of ids compiles unchanged when an id is added and silently omits it from
 * every iteration — the side-inventory drift this repo has shipped before.
 */
export const WORKSPACE_MENU_ENTRY_IDS = Object.keys(
  WORKSPACE_MENU_ENTRY_LABEL
) as readonly WorkspaceMenuEntryId[];

/** The accessible name of the menu trigger, on BOTH hosts. */
export const WORKSPACE_MENU_TRIGGER_LABEL = "Open account menu";

export const WorkspaceMenuProjectionStatus = {
  Ready: "ready",
  /** Signed out on a host that still offers the menu — Desktop's guest. */
  Guest: "guest",
  /** Identity has not hydrated yet. Never rendered as signed-out or empty. */
  Pending: "pending",
  Error: "error",
} as const;

export type WorkspaceMenuProjectionStatus =
  (typeof WorkspaceMenuProjectionStatus)[keyof typeof WorkspaceMenuProjectionStatus];

export type WorkspaceMenuWorkspaceSummary = {
  id: string;
  name: string;
  /** Null on a host with no slug in its URLs — the desktop renderer. */
  slug: string | null;
  imageUrl: string | null;
};

export type WorkspaceMenuActor = {
  name: string | null;
  email: string | null;
  imageUrl: string | null;
};

/**
 * What the menu renders from.
 *
 * `workspaces` lists every workspace the actor may switch to INCLUDING the
 * active one, so the radio group can mark the active row without a second
 * source disagreeing about membership.
 *
 * `downloadUrl` is non-null exactly when the `download-desktop` capability is
 * `Ready`. The adapter owns that coherence and `DownloadDesktopItem` enforces it
 * at the render site, which is the only place a violation could reach a user.
 *
 * IT RIDES ON EVERY STANDING, not only `Ready` (ISS-11400 review). The release
 * lookup needs no workspace identity at all — it is a public artifact URL — so a
 * projection that failed or has not settled still HOLDS the link, and carrying
 * it here is what lets every menu body render the entry its capability says is
 * `Ready`. Hanging it off the `Ready` member alone left the other three bodies
 * with a capability marked renderable and no operand to render it from, which
 * silently dropped a valid download from a menu opened on a failed identity
 * read.
 */
export type WorkspaceMenuProjection = {
  downloadUrl: string | null;
} & (
  | {
      status: typeof WorkspaceMenuProjectionStatus.Ready;
      activeWorkspace: WorkspaceMenuWorkspaceSummary;
      workspaces: readonly WorkspaceMenuWorkspaceSummary[];
      actor: WorkspaceMenuActor;
    }
  | { status: typeof WorkspaceMenuProjectionStatus.Guest }
  | { status: typeof WorkspaceMenuProjectionStatus.Pending }
  | {
      status: typeof WorkspaceMenuProjectionStatus.Error;
      reason: WorkspaceMenuCapabilityReason;
    }
);

export function workspaceMenuCapabilityReady(): WorkspaceMenuCapability {
  return { status: WorkspaceMenuCapabilityStatus.Ready };
}

export function workspaceMenuCapabilityPending(): WorkspaceMenuCapability {
  return { status: WorkspaceMenuCapabilityStatus.Pending };
}

export function workspaceMenuCapabilityUnavailable(
  reason: WorkspaceMenuCapabilityReason
): WorkspaceMenuCapability {
  return { status: WorkspaceMenuCapabilityStatus.Unavailable, reason };
}

export function workspaceMenuCapabilityError(
  reason: WorkspaceMenuCapabilityReason
): WorkspaceMenuCapability {
  return { status: WorkspaceMenuCapabilityStatus.Error, reason };
}

/**
 * Whether an entry is rendered at all. Only `Ready` renders: an `Unavailable`
 * entry is ABSENT rather than disabled, because a control that can never become
 * enabled is the UI lying about state.
 */
export function isWorkspaceMenuEntryRendered(
  capability: WorkspaceMenuCapability
): boolean {
  return capability.status === WorkspaceMenuCapabilityStatus.Ready;
}

/**
 * The entries Desktop does not offer at all. THE single source for that set —
 * `buildDesktopWorkspaceMenuCapabilities` derives its Unavailable entries by
 * iterating this array rather than re-listing them, so the two cannot drift
 * about what Desktop can reach.
 *
 * They are here for two different reasons, and the distinction matters to
 * anyone adding a fourth:
 *
 * - Organization switching, workspace creation and the desktop download are
 *   the operator ruling: Desktop is already inside one workspace and is
 *   already the download.
 * - Members is a capability gap, not a ruling (ISS-8368). The panel it links
 *   to is Clerk's `<OrganizationProfile>` embed, and the desktop renderer
 *   mounts no Clerk provider — `@clerk/*` appears nowhere under
 *   `apps/desktop/src/renderer`, whose auth runs through
 *   `desktop-auth-provider.tsx` — so that embed cannot mount there through any
 *   existing supported integration. The entry is omitted rather than left
 *   pointing at a panel that resolves `unavailable`.
 *
 * Frozen so a desktop adapter cannot acquire an org-switching, download or
 * members path by mutating a shared object — the structural guarantee
 * `WEB_SETTINGS_HOST_CAPABILITIES` gives the web local-device read.
 */
export const DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES: readonly WorkspaceMenuEntryId[] =
  Object.freeze([
    WorkspaceMenuEntryId.SwitchWorkspace,
    WorkspaceMenuEntryId.CreateWorkspace,
    WorkspaceMenuEntryId.DownloadDesktop,
    WorkspaceMenuEntryId.Members,
  ]);

/**
 * The host each surface reports as. Re-exported so a menu consumer names the
 * host through this module rather than reaching into the Settings panel
 * vocabulary for a value that is really "which surface am I".
 */
export const WorkspaceMenuHostId = SettingsPanelHost;
export type WorkspaceMenuHostId = SettingsPanelHost;
