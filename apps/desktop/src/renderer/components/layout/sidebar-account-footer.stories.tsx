import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { type ReactNode, useEffect, useRef } from "react";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { DesktopFeatureFlagProvider } from "../../feature-flags/desktop-feature-flag-provider";
import { NavId } from "../../navigation/route-table";
import { DesktopAuthProvider } from "../../shared-agent-sessions/desktop-auth-provider";
import { GuestSignupProvider } from "../onboarding/guest-signup-provider";
import { assertTextAbsent, waitForText } from "../story-text-assertions";
import { Sidebar } from "./Sidebar";

// ISS-5112 (PLN-1600 Step D, wongk story review on PR #4560): the sidebar
// footer's identity slot, signed in and as a guest.
// `guest-pre-auth-chrome.test.tsx` already pins the CORRECTNESS in both
// directions — a guest never sees an organization name or the "Account"
// fallback, and a signed-in device never reads "Guest". What it cannot pin is
// what the swap LOOKS like, and this PR changed exactly that: the guest slot
// went from a dashed-border box to an `Avatar` fallback, because a dashed
// outline means "nothing here yet" in this product and a guest is a person, not
// a missing thing. That change was made on review and shipped without anyone
// seeing it rendered.
// Worth a permanent fixture rather than a one-off look, because this state is
// expensive to reach in the running app FOREVER: it needs the guest-onboarding
// Labs flag on AND a signed-out session, so nobody stumbles into it.
// The two stories are meant to be read as a pair — the leak this footer must
// never spring is an organization name reaching a signed-out guest, and the two
// canvases put the two treatments side by side.
// Unlike `dashboard-header-actions`, a canvas is FAITHFUL here: the sidebar is
// fixed-width, so nothing about this depends on the page container the way the
// dashboard's wrapping title row does.
/**
 * The identity control at the bottom of the sidebar that opens the account
 * menu, the only place Settings and Diagnostics live in the app.
 */
const meta = {
  title: "Composites/App Shell/Sidebar Account Footer",
  component: Sidebar,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
};

export default meta;

/**
 * A guest: the `guest-onboarding` flag on, no session. The footer reads "Guest"
 * behind an avatar fallback, and the menu behind it still carries Settings,
 * Diagnostics and Theme — open it on the canvas. An earlier revision replaced
 * the whole dropdown with a bare button, which stranded a signed-out user with
 * no route to Settings and therefore no way to turn this very flag back off.
 */
export const Guest = {
  render: () => stage({ guestOnboarding: true, signedIn: false }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    // The flag resolves through a real IPC round-trip, so without this the
    // canvas could settle on the signed-in fallback and the story would be a
    // lie that still mounted green in the sweep.
    await waitForText(canvasElement, GUEST_LABEL);
    assertTextAbsent(canvasElement, ORG_NAME);
    assertTextAbsent(canvasElement, ACCOUNT_FALLBACK);
  },
};

/**
 * The same footer signed in. The trigger reads the organization name behind the
 * Closedloop mark — the treatment a guest must never be shown, and the reason
 * the guest branch exists at all.
 */
export const SignedIn = {
  render: () => stage({ guestOnboarding: false, signedIn: true }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForText(canvasElement, ORG_NAME);
    assertTextAbsent(canvasElement, GUEST_LABEL);
  },
};

/**
 * The flag ON but signed IN. Guest chrome is gated on BOTH, so this must render
 * identically to {@link SignedIn}: turning the flag on for a real account may
 * never relabel them "Guest".
 */
export const FlagOnButSignedIn = {
  render: () => stage({ guestOnboarding: true, signedIn: true }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    // The assertion that makes this story worth having: the flag is ON here, so
    // a guest branch gated on the flag ALONE would relabel a real account
    // "Guest". It is gated on the flag AND signed-out.
    await waitForText(canvasElement, ORG_NAME);
    assertTextAbsent(canvasElement, GUEST_LABEL);
  },
};

const GUEST_LABEL = "Guest";
const ORG_NAME = "Northwind Engineering";
const ACCOUNT_FALLBACK = "Account";

type Fixture = { guestOnboarding: boolean; signedIn: boolean };

/**
 * The real providers over a stubbed preload bridge, rather than mocked hooks:
 * `useGuestOnboarding` reads the flag through `DesktopFeatureFlagProvider`
 * (which supplies the `@repo/app` adapter itself) and the auth status through
 * `DesktopAppCoreProvider`, so stubbing `window.desktopApi` is what exercises
 * the same resolution path the packaged app takes. A story cannot `vi.mock`,
 * which is the other reason to drive it from the bridge.
 */
function installBridge({ guestOnboarding, signedIn }: Fixture): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      // Unpackaged, which is what lets the flag registry resolve at all.
      getRuntimeStatus: () => Promise.resolve({ isPackaged: false }),
      // `{ flags: [{ key, value }] }`, NOT a flat record — `extractDesktopFlags`
      // ignores anything without that array and silently falls back to the
      // registry defaults, which for this default-off flag is indistinguishable
      // from the flag being off. The `play` below is what caught that: the
      // story mounted perfectly green while rendering signed-in chrome.
      getAllFlags: () =>
        Promise.resolve({
          flags: [
            {
              key: DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY,
              value: guestOnboarding,
            },
          ],
        }),
      getDesktopAuthState: () =>
        Promise.resolve(
          signedIn
            ? {
                status: DesktopAuthStatus.Authenticated,
                userId: "user_story",
                organizationId: "org_story",
              }
            : {
                status: DesktopAuthStatus.SignedOut,
                userId: null,
                organizationId: null,
              }
        ),
      getDesktopIdentity: () =>
        Promise.resolve(
          signedIn
            ? {
                email: "ada@northwind.dev",
                name: "Ada Lovelace",
                organizationName: "Northwind Engineering",
              }
            : null
        ),
    },
    writable: true,
  });
  return () => {
    if (original) {
      Object.defineProperty(window, "desktopApi", original);
      return;
    }
    Reflect.deleteProperty(window, "desktopApi");
  };
}

function stage(fixture: Fixture): ReactNode {
  return <SidebarFooterStage fixture={fixture} />;
}

/**
 * Installs the bridge for THIS story only, and puts the global back on unmount.
 *
 * Both halves are load-bearing. It installs during render rather than in an
 * effect because a parent's effects run AFTER its children's, and
 * `DesktopFeatureFlagProvider` reads the bridge in its own mount effect — an
 * effect here would arrive too late and the flag would resolve off whatever was
 * already on `window`.
 *
 * And it RESTORES, which the sibling desktop story fixtures do not. The
 * Storybook sweep (ISS-5287) mounts every story into one shared jsdom, and a
 * partial `window.desktopApi` left behind is not inert: shared code branches on
 * the bridge's presence to pick a desktop transport, so an unrelated
 * `packages/app` story took that path against a stub missing its method and
 * failed on the undefined payload. Leaving this global set broke a story three
 * packages away.
 */
function SidebarFooterStage({ fixture }: { fixture: Fixture }) {
  const restore = useRef<(() => void) | null>(null);
  if (restore.current === null) {
    restore.current = installBridge(fixture);
  }
  useEffect(
    () => () => {
      restore.current?.();
      restore.current = null;
    },
    []
  );

  // No app-core wrapper here on purpose (ISS-5697): the QueryClient, auth and
  // API ports come from the ONE `AppCoreStoryProviders` the preview's global
  // decorator mounts, which builds a FRESH client per story. This stage adds
  // only the DESKTOP-specific providers below it.
  //
  // What must never be reintroduced here is `DesktopAppCoreProvider`: it caches
  // its per-mode QueryClients module-globally, so in the shared sweep that cache
  // outlives the story, and this sidebar issues real queries (agent counts,
  // session limits) whose entries then reach whatever runs next.
  return (
    <DesktopAuthProvider>
      <DesktopFeatureFlagProvider>
        <GuestSignupProvider>
          <SidebarProvider>
            <Sidebar activeNav={NavId.Sessions} />
          </SidebarProvider>
        </GuestSignupProvider>
      </DesktopFeatureFlagProvider>
    </DesktopAuthProvider>
  );
}
