import {
  DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES,
  isWorkspaceMenuEntryRendered,
  WORKSPACE_MENU_ENTRY_IDS,
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuCapabilityStatus,
  WorkspaceMenuEntryId,
  workspaceMenuCapabilityError,
  workspaceMenuCapabilityReady,
} from "@repo/api/src/types/workspace-menu";
import { describe, expect, test } from "vitest";
import {
  buildDesktopWorkspaceMenuCapabilities,
  buildWebWorkspaceMenuCapabilities,
} from "../workspace-menu-capabilities";

const WEB_READY = buildWebWorkspaceMenuCapabilities({
  download: workspaceMenuCapabilityReady(),
});

describe("desktop capability policy", () => {
  test("omits every contract-omitted entry, signed in or guest", () => {
    // The 2026-09-03 operator ruling: Desktop omits Switch workspace, Create a
    // workspace, and Download desktop app COMPLETELY. ISS-8368 adds Members for
    // a different reason — the Clerk embed behind it cannot mount in the
    // desktop renderer. Guest state must not be a back door into any of them.
    for (const isGuest of [false, true]) {
      const capabilities = buildDesktopWorkspaceMenuCapabilities({ isGuest });
      for (const entry of DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES) {
        expect(capabilities[entry].status).toBe(
          WorkspaceMenuCapabilityStatus.Unavailable
        );
        expect(isWorkspaceMenuEntryRendered(capabilities[entry])).toBe(false);
      }
    }
  });

  test("reports every one of them as not-supported, not as a failed read", () => {
    const capabilities = buildDesktopWorkspaceMenuCapabilities({
      isGuest: false,
    });
    for (const entry of DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES) {
      const capability = capabilities[entry];
      // Narrows to the reason-carrying arms, and asserts the stronger claim
      // directly: these are Unavailable, not merely non-Ready.
      if (capability.status !== WorkspaceMenuCapabilityStatus.Unavailable) {
        throw new Error(`${entry} must be Unavailable on desktop`);
      }
      expect(capability.reason).toBe(
        WorkspaceMenuCapabilityReason.NotSupportedOnHost
      );
    }
  });

  test("keeps Settings and Diagnostics for a guest — the way back in", () => {
    // ISS-5112: this menu is the only link site for Settings and Diagnostics in
    // the renderer, and Settings -> Account is how a signed-out user signs in.
    const guest = buildDesktopWorkspaceMenuCapabilities({ isGuest: true });

    expect(
      isWorkspaceMenuEntryRendered(guest[WorkspaceMenuEntryId.Settings])
    ).toBe(true);
    expect(
      isWorkspaceMenuEntryRendered(guest[WorkspaceMenuEntryId.Diagnostics])
    ).toBe(true);
    expect(
      isWorkspaceMenuEntryRendered(guest[WorkspaceMenuEntryId.CreateAccount])
    ).toBe(true);
    expect(
      isWorkspaceMenuEntryRendered(guest[WorkspaceMenuEntryId.SignIn])
    ).toBe(true);
  });

  test("withholds identity-bound entries from a guest", () => {
    const guest = buildDesktopWorkspaceMenuCapabilities({ isGuest: true });

    for (const entry of [WorkspaceMenuEntryId.LogOut]) {
      const capability = guest[entry];
      expect(isWorkspaceMenuEntryRendered(capability)).toBe(false);
      if (capability.status !== WorkspaceMenuCapabilityStatus.Unavailable) {
        throw new Error(`${entry} must be Unavailable for a guest`);
      }
      expect(capability.reason).toBe(WorkspaceMenuCapabilityReason.SignedOut);
    }
  });

  test("reports Members as not-supported, never as signed-out", () => {
    // ISS-8368 moved Members from identity-bound to host-bound on desktop. The
    // two reasons say different things to a user: `SignedOut` promises the
    // entry comes back after signing in, and on desktop it never does, because
    // the renderer mounts no Clerk provider for the embed behind it. A guest
    // must get the host reason too, or signing in would be offered as a remedy
    // for something signing in cannot fix.
    for (const isGuest of [false, true]) {
      const members = buildDesktopWorkspaceMenuCapabilities({ isGuest })[
        WorkspaceMenuEntryId.Members
      ];
      if (members.status !== WorkspaceMenuCapabilityStatus.Unavailable) {
        throw new Error("Members must be Unavailable on desktop");
      }
      expect(members.reason).toBe(
        WorkspaceMenuCapabilityReason.NotSupportedOnHost
      );
      expect(members.reason).not.toBe(WorkspaceMenuCapabilityReason.SignedOut);
    }
  });

  test("keeps Members on web, so the omission is host-scoped", () => {
    // The mirror of the test above. Without it, deleting Members from the
    // product entirely would satisfy every desktop assertion here.
    expect(
      isWorkspaceMenuEntryRendered(WEB_READY[WorkspaceMenuEntryId.Members])
    ).toBe(true);
  });

  test("offers Diagnostics on desktop, and withholds it from web by default", () => {
    const desktop = buildDesktopWorkspaceMenuCapabilities({ isGuest: false });

    expect(
      isWorkspaceMenuEntryRendered(desktop[WorkspaceMenuEntryId.Diagnostics])
    ).toBe(true);
    expect(
      isWorkspaceMenuEntryRendered(WEB_READY[WorkspaceMenuEntryId.Diagnostics])
    ).toBe(false);
  });

  /**
   * ISS-10362. Pinned HERE rather than only through the menu: `GuestWorkspaceMenu`
   * never passes the invite controller at all, so a render-level guest assertion
   * stays green with this policy inverted — it would be measuring the wrong
   * thing. The capability is the contract, so the capability is what is asserted.
   */
  test("offers Invite to a signed-in desktop and withholds it from a guest", () => {
    expect(
      isWorkspaceMenuEntryRendered(
        buildDesktopWorkspaceMenuCapabilities({ isGuest: false })[
          WorkspaceMenuEntryId.Invite
        ]
      )
    ).toBe(true);

    const guest = buildDesktopWorkspaceMenuCapabilities({ isGuest: true })[
      WorkspaceMenuEntryId.Invite
    ];
    expect(guest.status).toBe(WorkspaceMenuCapabilityStatus.Unavailable);
    // SignedOut, not NotSupportedOnHost: desktop HAS invite, this actor has no
    // organization to invite anyone into. The two must not render alike.
    expect("reason" in guest && guest.reason).toBe(
      WorkspaceMenuCapabilityReason.SignedOut
    );
  });

  test("keeps Invite off web, which reaches the same job through Members", () => {
    const web = WEB_READY[WorkspaceMenuEntryId.Invite];

    expect(web.status).toBe(WorkspaceMenuCapabilityStatus.Unavailable);
    expect("reason" in web && web.reason).toBe(
      WorkspaceMenuCapabilityReason.NotSupportedOnHost
    );
    // The sibling that makes the absence correct rather than a gap.
    expect(
      isWorkspaceMenuEntryRendered(WEB_READY[WorkspaceMenuEntryId.Members])
    ).toBe(true);
  });
});

describe("web capability policy", () => {
  test("offers every entry desktop omits", () => {
    for (const entry of DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES) {
      expect(isWorkspaceMenuEntryRendered(WEB_READY[entry])).toBe(true);
    }
  });

  test("a failed release read is an Error, never a missing entry", () => {
    // Web HAS the download feature; the read failed. Reporting that as
    // Unavailable would claim web never had it, which is the conflation the
    // capability union exists to prevent.
    const capabilities = buildWebWorkspaceMenuCapabilities({
      download: workspaceMenuCapabilityError(
        WorkspaceMenuCapabilityReason.ReadFailed
      ),
    });
    const download = capabilities[WorkspaceMenuEntryId.DownloadDesktop];

    expect(download.status).toBe(WorkspaceMenuCapabilityStatus.Error);
    expect(download.status).not.toBe(WorkspaceMenuCapabilityStatus.Unavailable);
  });
});

describe("both hosts", () => {
  test("answer for every entry id — no missing keys", () => {
    // A missing key would read as undefined at the render site and silently drop
    // the entry, which is the same failure as an omitted adapter method.
    for (const capabilities of [
      WEB_READY,
      buildDesktopWorkspaceMenuCapabilities({ isGuest: false }),
      buildDesktopWorkspaceMenuCapabilities({ isGuest: true }),
    ]) {
      for (const id of WORKSPACE_MENU_ENTRY_IDS) {
        expect(capabilities[id]).toBeDefined();
        expect(Object.values(WorkspaceMenuCapabilityStatus)).toContain(
          capabilities[id].status
        );
      }
    }
  });

  test("render the same Settings and different switch availability", () => {
    // One presentation, two item sets — the ruling's shape, in one assertion.
    const desktop = buildDesktopWorkspaceMenuCapabilities({ isGuest: false });

    expect(
      isWorkspaceMenuEntryRendered(WEB_READY[WorkspaceMenuEntryId.Settings])
    ).toBe(
      isWorkspaceMenuEntryRendered(desktop[WorkspaceMenuEntryId.Settings])
    );
    expect(
      isWorkspaceMenuEntryRendered(
        WEB_READY[WorkspaceMenuEntryId.SwitchWorkspace]
      )
    ).not.toBe(
      isWorkspaceMenuEntryRendered(
        desktop[WorkspaceMenuEntryId.SwitchWorkspace]
      )
    );
  });
});
