import {
  DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES,
  isWorkspaceMenuEntryRendered,
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuCapabilityStatus,
  WorkspaceMenuEntryId,
  WorkspaceMenuHostId,
  WorkspaceMenuProjectionStatus,
} from "@repo/api/src/types/workspace-menu";
import { describe, expect, test } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import {
  createDesktopWorkspaceMenuHostAdapter,
  type DesktopWorkspaceMenuHostInput,
  toDesktopWorkspaceMenuCapabilities,
  toDesktopWorkspaceMenuProjection,
} from "../desktop-workspace-menu-host-adapter";

function input(
  overrides: Partial<DesktopWorkspaceMenuHostInput> = {}
): DesktopWorkspaceMenuHostInput {
  return {
    identity: {
      organizationName: "Closedloop",
      userName: "Ada Lovelace",
      email: "ada@closedloop.ai",
      organizationImageUrl: "https://img.clerk.com/org-logo",
      userImageUrl: "https://img.clerk.com/user-avatar",
    },
    authStatus: DesktopAuthStatus.Authenticated,
    isResolved: true,
    diagnosticsHref: "/diagnostics",
    signOut: () => Promise.resolve(),
    requestAccount: () => undefined,
    ...overrides,
  };
}

describe("toDesktopWorkspaceMenuProjection", () => {
  test("a signed-out desktop is Guest, not Pending and not Error", () => {
    // A guest has settled on having no identity deliberately. Reporting Pending
    // would spin forever; reporting Error would call a supported state a fault.
    expect(
      toDesktopWorkspaceMenuProjection(
        input({ authStatus: DesktopAuthStatus.SignedOut, identity: null })
      ).status
    ).toBe(WorkspaceMenuProjectionStatus.Guest);
  });

  test("every mid-sign-in status is Pending, never 'Account unavailable'", () => {
    // `useDesktopIdentity` reports ALL of these as resolved-with-no-identity, so
    // a settlement rule that reads `isResolved` alone tells a user who is part
    // way through signing in that their account is unavailable.
    for (const authStatus of [
      DesktopAuthStatus.Loading,
      DesktopAuthStatus.OpeningBrowser,
      DesktopAuthStatus.AwaitingRedirect,
      DesktopAuthStatus.Exchanging,
    ]) {
      expect(
        toDesktopWorkspaceMenuProjection(
          input({ authStatus, identity: null, isResolved: true })
        ).status
      ).toBe(WorkspaceMenuProjectionStatus.Pending);
    }
  });

  test("a lapsed session is an Error, not a permanent Pending", () => {
    // RefreshFailed cleared the credentials. `canOfferAccount` excludes it from
    // guest mode, so it must not sit on "Loading" waiting for an identity that
    // is never coming.
    const projection = toDesktopWorkspaceMenuProjection(
      input({ authStatus: DesktopAuthStatus.RefreshFailed, identity: null })
    );

    expect(projection.status).toBe(WorkspaceMenuProjectionStatus.Error);
    if (projection.status !== WorkspaceMenuProjectionStatus.Error) {
      throw new Error("expected an Error projection");
    }
    expect(projection.reason).toBe(WorkspaceMenuCapabilityReason.ReadFailed);
  });

  test("an authenticated identity still fetching is Pending", () => {
    expect(
      toDesktopWorkspaceMenuProjection(
        input({ identity: null, isResolved: false })
      ).status
    ).toBe(WorkspaceMenuProjectionStatus.Pending);
  });

  test("an authenticated read that resolved to nothing is an Error", () => {
    expect(
      toDesktopWorkspaceMenuProjection(input({ identity: null })).status
    ).toBe(WorkspaceMenuProjectionStatus.Error);
  });

  test("a settled identity yields exactly one workspace, slug-less", () => {
    const projection = toDesktopWorkspaceMenuProjection(input());

    if (projection.status !== WorkspaceMenuProjectionStatus.Ready) {
      throw new Error("expected a Ready projection");
    }
    // Single-org by construction, and desktop URLs carry no org slug.
    expect(projection.workspaces).toHaveLength(1);
    expect(projection.activeWorkspace.slug).toBeNull();
    expect(projection.activeWorkspace.name).toBe("Closedloop");
    expect(projection.actor.email).toBe("ada@closedloop.ai");
    // Desktop IS the desktop app; a download URL here would be a dead link.
    expect(projection.downloadUrl).toBeNull();
  });
});

describe("createDesktopWorkspaceMenuHostAdapter", () => {
  test("exposes no organization-switching path at all", () => {
    // The 2026-09-03 operator ruling, made structural: not a disabled control,
    // not an entry the render filters out later — the capability simply is not
    // on the adapter, so no desktop code path can reach org switching.
    const adapter = createDesktopWorkspaceMenuHostAdapter(input());

    expect(adapter.switchWorkspace).toBeUndefined();
    expect(adapter.createWorkspaceSlot).toBeUndefined();
    expect(adapter.host).toBe(WorkspaceMenuHostId.Desktop);
  });

  test("marks every contract-omitted entry unavailable", () => {
    const capabilities = toDesktopWorkspaceMenuCapabilities(input());

    for (const entry of DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES) {
      expect(isWorkspaceMenuEntryRendered(capabilities[entry])).toBe(false);
    }
  });

  // The org-path join is NOT on this adapter any more: it belongs to the
  // navigation port, whose desktop implementation (`identityOrgPath`) is pinned
  // by `navigation/__tests__/desktop-adapter.test.tsx` — "returns org-relative
  // paths unchanged from useOrgPath". Asserting it a second time here would be
  // duplicating a contract that already has an owner.

  /**
   * ISS-11400 review — Invite tracks the STANDING, not just the guest gate.
   *
   * `ReadyWorkspaceMenu` is the only body that has ever mounted the invite row
   * or its dialog, and Pending and Error do not mount it. A `Ready` capability
   * there is a control the menu claims and cannot offer — the same lie as the
   * disabled trigger this ticket removes.
   */
  test("withholds Invite on every standing that mounts no invite controller", () => {
    // Pending: the identity fetch has not produced an organization id yet, and
    // the dialog mints invitations against one.
    expect(
      toDesktopWorkspaceMenuCapabilities(
        input({ identity: null, isResolved: false })
      )[WorkspaceMenuEntryId.Invite].status
    ).toBe(WorkspaceMenuCapabilityStatus.Pending);

    // Error: the read that should have produced it failed. Kept DISTINCT from
    // Pending — that separation is the whole reason the capability union has
    // four members rather than a boolean.
    const errored = toDesktopWorkspaceMenuCapabilities(
      input({ identity: null })
    )[WorkspaceMenuEntryId.Invite];
    expect(errored.status).toBe(WorkspaceMenuCapabilityStatus.Error);
    if (
      errored.status !== WorkspaceMenuCapabilityStatus.Error &&
      errored.status !== WorkspaceMenuCapabilityStatus.Unavailable
    ) {
      throw new Error("expected a capability carrying a reason");
    }
    expect(errored.reason).toBe(WorkspaceMenuCapabilityReason.ReadFailed);

    // A guest keeps the host policy's own answer rather than being re-decided
    // here, so the guest gate stays the single owner of it.
    expect(
      toDesktopWorkspaceMenuCapabilities(
        input({ authStatus: DesktopAuthStatus.SignedOut, identity: null })
      )[WorkspaceMenuEntryId.Invite].status
    ).toBe(WorkspaceMenuCapabilityStatus.Unavailable);

    // The positive control, and the arm that keeps this from passing by
    // withholding Invite unconditionally.
    expect(
      isWorkspaceMenuEntryRendered(
        toDesktopWorkspaceMenuCapabilities(input())[WorkspaceMenuEntryId.Invite]
      )
    ).toBe(true);
  });

  /**
   * ISS-11400 review (tamsinb) — Log out takes a DIFFERENT standing set from
   * Invite, and the difference is the point.
   *
   * `isDesktopWorkspaceMenuGuest` is true for `SignedOut` alone, so a guest who
   * clicks sign in moves into `OpeningBrowser`/`AwaitingRedirect`/`Exchanging` —
   * Pending — and the menu offered them "Log out" with no session, for as long
   * as the browser tab sat there. `signOut()` there cancels the sign-in run, so
   * the row does not do what its label says.
   */
  test("withholds Log out while a sign-in is in flight", () => {
    for (const authStatus of [
      DesktopAuthStatus.Loading,
      DesktopAuthStatus.OpeningBrowser,
      DesktopAuthStatus.AwaitingRedirect,
      DesktopAuthStatus.Exchanging,
    ]) {
      expect(
        toDesktopWorkspaceMenuCapabilities(
          input({ authStatus, identity: null, isResolved: true })
        )[WorkspaceMenuEntryId.LogOut].status
      ).toBe(WorkspaceMenuCapabilityStatus.Pending);
    }
  });

  test("keeps Log out on Error, which is the recovery ISS-11400 exists for", () => {
    // The permutation that stops the case above from passing by withholding Log
    // out everywhere. An Error standing HAS a session — one that went wrong —
    // and ending it is a user's way back to the sign-in door, which is why
    // `STANDINGS_WITHOUT_A_SESSION` deliberately excludes it.
    for (const standing of [
      input({ authStatus: DesktopAuthStatus.RefreshFailed, identity: null }),
      input({ identity: null }),
    ]) {
      expect(
        isWorkspaceMenuEntryRendered(
          toDesktopWorkspaceMenuCapabilities(standing)[
            WorkspaceMenuEntryId.LogOut
          ]
        )
      ).toBe(true);
    }

    // ...and a guest still has nothing to end, per the host policy's own gate.
    expect(
      toDesktopWorkspaceMenuCapabilities(
        input({ authStatus: DesktopAuthStatus.SignedOut, identity: null })
      )[WorkspaceMenuEntryId.LogOut].status
    ).toBe(WorkspaceMenuCapabilityStatus.Unavailable);
  });

  test("carries the host's Diagnostics destination", () => {
    const adapter = createDesktopWorkspaceMenuHostAdapter(
      input({ diagnosticsHref: "/diagnostics" })
    );

    expect(adapter.diagnosticsHref).toBe("/diagnostics");
  });
});

describe("ISS-11465 workspace menu images", () => {
  test("the org logo and user avatar reach the projection", () => {
    // The defect this replaces: the adapter hardcoded `imageUrl: null` on BOTH
    // the workspace and the actor, so desktop rendered an initial where web
    // rendered the real logo. Asserting the populated case is the whole point —
    // a test that only covered the fallback stayed green throughout that bug.
    const projection = toDesktopWorkspaceMenuProjection(input());
    if (projection.status !== WorkspaceMenuProjectionStatus.Ready) {
      throw new Error(`expected Ready, got ${projection.status}`);
    }
    expect(projection.activeWorkspace.imageUrl).toBe(
      "https://img.clerk.com/org-logo"
    );
    expect(projection.workspaces[0]?.imageUrl).toBe(
      "https://img.clerk.com/org-logo"
    );
    expect(projection.actor.imageUrl).toBe("https://img.clerk.com/user-avatar");
  });

  test("null images still render, with no image", () => {
    // What this input actually is: the NORMALIZED shape, both images already
    // `null`. The absent-key case — an older server that omits the fields
    // entirely — happens one layer up, at the provider's `??`, and is pinned
    // there (`desktop-workspace-menu-host-provider.test.tsx`); this adapter's
    // input type cannot express it.
    const projection = toDesktopWorkspaceMenuProjection(
      input({
        identity: {
          organizationName: "Closedloop",
          userName: "Ada Lovelace",
          email: "ada@closedloop.ai",
          organizationImageUrl: null,
          userImageUrl: null,
        },
      })
    );
    if (projection.status !== WorkspaceMenuProjectionStatus.Ready) {
      throw new Error(`expected Ready, got ${projection.status}`);
    }
    expect(projection.activeWorkspace.imageUrl).toBeNull();
    expect(projection.actor.imageUrl).toBeNull();
  });
});
