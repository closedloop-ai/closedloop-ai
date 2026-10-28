import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import {
  isWorkspaceMenuEntryRendered,
  WORKSPACE_MENU_ENTRY_IDS,
  WORKSPACE_MENU_ENTRY_LABEL,
  WORKSPACE_MENU_TRIGGER_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import { WorkspaceMenu } from "@repo/app/settings/v2/components/workspace-menu/workspace-menu";
import { WorkspaceMenuHostAdapterProvider } from "@repo/app/shared/workspace-menu-host/provider";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import {
  createDesktopWorkspaceMenuHostAdapter,
  type DesktopWorkspaceMenuHostInput,
  toDesktopWorkspaceMenuCapabilities,
} from "../desktop-workspace-menu-host-adapter";

/**
 * ISS-11400, on the surface that reported it.
 *
 * The sibling adapter suite pins which STANDING each desktop auth state lands
 * in; this pins what the rendered menu does in the two standings that used to
 * render a dead trigger. It mounts the real `WorkspaceMenu` through the real
 * `createDesktopWorkspaceMenuHostAdapter`, so a capability regression in the
 * desktop builder fails here and not only in the shared package's fixture.
 */

vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: () => null,
}));

function input(
  overrides: Partial<DesktopWorkspaceMenuHostInput> = {}
): DesktopWorkspaceMenuHostInput {
  return {
    identity: null,
    authStatus: DesktopAuthStatus.Authenticated,
    isResolved: true,
    diagnosticsHref: "/diagnostics",
    signOut: () => Promise.resolve(),
    requestAccount: () => undefined,
    requestSignIn: () => undefined,
    ...overrides,
  };
}

function renderDesktopMenu(
  overrides: Partial<DesktopWorkspaceMenuHostInput> = {}
): HTMLElement {
  render(
    <NavigationProvider
      adapter={createMemoryNavigation({ initialPath: "/dashboard" }).adapter}
    >
      <SidebarProvider>
        <WorkspaceMenuHostAdapterProvider
          adapter={createDesktopWorkspaceMenuHostAdapter(input(overrides))}
        >
          <WorkspaceMenu />
        </WorkspaceMenuHostAdapterProvider>
      </SidebarProvider>
    </NavigationProvider>
  );
  // Radix dropdowns open on pointerdown, not click. Returning the menu means an
  // assertion cannot pass against a dropdown that never opened.
  fireEvent.pointerDown(
    screen.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL }),
    { button: 0, ctrlKey: false }
  );
  return screen.getByRole("menu");
}

describe("the desktop menu on a failed identity read", () => {
  // SidebarProvider reads matchMedia to derive the mobile breakpoint; jsdom has
  // no implementation, so stub it (restored in afterEach).
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("opens, and names Settings and Diagnostics", () => {
    // The operator's screenshot: signed in, `GET /desktop/identity` resolved to
    // nothing, and the whole menu was disabled behind "Account unavailable".
    const menu = renderDesktopMenu();

    expect(
      within(menu).getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
      )
    ).toBeTruthy();
    expect(
      within(menu).getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Diagnostics]
      )
    ).toBeTruthy();
    // The trigger keeps the honest word — a working control, not a fake name.
    expect(screen.getByText("Account unavailable")).toBeTruthy();
  });

  test("a lapsed session can sign out from it", () => {
    // RefreshFailed cleared the credentials and is deliberately not a guest, so
    // Log out is this user's whole route back to the sign-in door.
    const signOut = vi.fn(() => Promise.resolve());
    const menu = renderDesktopMenu({
      authStatus: DesktopAuthStatus.RefreshFailed,
      signOut,
    });

    fireEvent.click(
      within(menu).getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut]
      )
    );

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test("a still-loading identity reaches Settings too (AC3)", () => {
    // Pending is decided explicitly rather than by fall-through: a wedged load
    // strands a user exactly as a failed read does.
    const menu = renderDesktopMenu({ isResolved: false });

    expect(
      within(menu).getByText(
        WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]
      )
    ).toBeTruthy();
    expect(screen.getByText("Loading")).toBeTruthy();
  });
});

/**
 * ISS-11400 review (tamsinb) — the STRUCTURAL guard, added after the same
 * defect reached review under three different entries: Download, Invite and Log
 * out, each projected `Ready` into a body that mounts no controller for it.
 *
 * Rather than police those three by name, this walks `WORKSPACE_MENU_ENTRY_IDS`
 * — derived from the exhaustive label map, so a NEW entry joins it without
 * anyone remembering to — and holds one invariant over the real adapter and the
 * real menu: on a standing that renders `ProjectedWorkspaceMenu`, every entry
 * the host marks `Ready` must actually appear in the opened menu. A fourth
 * instance of this defect fails here rather than in review.
 */
describe("every Ready entry reaches the projected menu (ISS-11400)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test.each([
    ["Error", { identity: null }],
    ["Pending", { isResolved: false }],
    ["Guest", { authStatus: DesktopAuthStatus.SignedOut, identity: null }],
  ] as const)("%s", (_standing, overrides) => {
    const capabilities = toDesktopWorkspaceMenuCapabilities(input(overrides));
    const ready = WORKSPACE_MENU_ENTRY_IDS.filter((entry) =>
      isWorkspaceMenuEntryRendered(capabilities[entry])
    );
    // Positive control: an empty Ready set would satisfy the loop below
    // vacuously, and is also the "menu opens onto nothing" failure this ticket
    // refuses in its own right.
    expect(ready.length).toBeGreaterThan(0);

    const menu = renderDesktopMenu(overrides);
    for (const entry of ready) {
      expect(
        within(menu).getByText(WORKSPACE_MENU_ENTRY_LABEL[entry])
      ).toBeTruthy();
    }
  });
});
