/**
 * ISS-5112 (PLN-1600 Step D): the invite item's half of the resume, which only
 * runs AFTER a browser round-trip.
 *
 * Signed out, "Invite your team" asks for an account instead of opening a
 * dialog that mints Clerk invitations against an org id a guest does not have.
 * The point of carrying WHICH surface asked is that finishing sign-up then
 * gives them the dialog they were reaching for — otherwise they are returned to
 * a sidebar and left to find it again, having been interrupted for nothing.
 *
 * Nothing covered that: `Sidebar.tsx`'s resume effect was the one branch in this
 * feature with no test, the mirror of the gap the coverage gate caught in
 * `useOrgScopeGate`.
 *
 * `useGuestSignup` is stubbed for the same reason it is in
 * `use-org-scope-gate.test.tsx`: `resuming` is only produced by the reducer's
 * `signed-up` action, which `guest-signup-provider.test.ts` pins, and reaching
 * it for real needs a full OAuth round-trip plus both setup steps.
 */
import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { GuestSignupIntent } from "../../onboarding/guest-signup-provider";
import { Sidebar } from "../Sidebar";

const INVITE_LABEL = "Invite your team";
const clearResume = vi.fn();
const requestSignup = vi.fn();
let resuming: GuestSignupIntent | null = null;

vi.mock("../../onboarding/guest-signup-provider", async () => ({
  ...(await vi.importActual<
    typeof import("../../onboarding/guest-signup-provider")
  >("../../onboarding/guest-signup-provider")),
  useGuestSignup: () => ({ requestSignup, resuming, clearResume }),
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

beforeEach(() => {
  // AUTHENTICATED, which is what a resume means: the sign-up the ask
  // interrupted has completed. `canOfferAccount` is false here, so the sidebar
  // renders the real invite dialog rather than the guest ask.
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: () =>
        Promise.resolve({
          status: DesktopAuthStatus.Authenticated,
          userId: "user_test",
          organizationId: "org_test",
        }),
    },
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resuming = null;
});

function renderSidebar() {
  const memoryNav = createMemoryNavigation({ initialPath: "/sessions" });
  return render(
    <DesktopAppCoreProvider>
      <NavigationProvider adapter={memoryNav.adapter}>
        <SidebarProvider>
          <Sidebar activeNav={NavId.Sessions} />
        </SidebarProvider>
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
}

describe("guest invite resume (ISS-5112)", () => {
  it("hands back the invite dialog the ask interrupted", async () => {
    resuming = GuestSignupIntent.Invite;

    renderSidebar();

    expect(
      await screen.findByRole("dialog", { name: INVITE_LABEL })
    ).toBeDefined();
    // The marker is consumed, so the dialog cannot reopen itself on every later
    // render for the rest of the session.
    expect(clearResume).toHaveBeenCalledTimes(1);
  });

  it("leaves another surface's resume alone", async () => {
    // The organization gate's sign-up resumes ORGANIZATION SCOPE. A resume
    // marker is not a broadcast: opening on any intent would throw an invite
    // dialog at someone who asked for a dashboard view.
    resuming = GuestSignupIntent.Organization;

    renderSidebar();

    await screen.findByRole("button", { name: INVITE_LABEL });
    expect(screen.queryByRole("dialog", { name: INVITE_LABEL })).toBeNull();
    expect(clearResume).not.toHaveBeenCalled();
  });

  it("stays shut when nothing was interrupted", async () => {
    renderSidebar();

    await screen.findByRole("button", { name: INVITE_LABEL });
    expect(screen.queryByRole("dialog", { name: INVITE_LABEL })).toBeNull();
    expect(clearResume).not.toHaveBeenCalled();
  });
});
