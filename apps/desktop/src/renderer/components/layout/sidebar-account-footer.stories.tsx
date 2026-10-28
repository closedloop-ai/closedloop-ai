import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { type ReactNode, useEffect, useRef } from "react";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { DesktopFeatureFlagProvider } from "../../feature-flags/desktop-feature-flag-provider";
import { NavId } from "../../navigation/route-table";
import { DesktopAuthProvider } from "../../shared-agent-sessions/desktop-auth-provider";
import { assertTextAbsent, waitForText } from "../story-text-assertions";
import { Sidebar } from "./Sidebar";

/**
 * ISS-5112 (PLN-1600 Step D, whitlockk story review on PR #4560): the sidebar
 * footer's identity slot, signed in and as a guest.
 *
 * `guest-pre-auth-chrome.test.tsx` already pins the CORRECTNESS of the guest
 * side — a guest never sees an organization name or the "Account" fallback —
 * and {@link SignedIn} below is what holds the other direction, since every case
 * in that suite is signed out. What neither can pin is what the swap LOOKS like, and this PR changed exactly that: the guest slot
 * went from a dashed-border box to an `Avatar` fallback, because a dashed
 * outline means "nothing here yet" in this product and a guest is a person, not
 * a missing thing. That change was made on review and shipped without anyone
 * seeing it rendered.
 *
 * Worth a permanent fixture rather than a one-off look: reaching it in the
 * running app means signing out, which nobody does on the way to anywhere else.
 *
 * The two stories are meant to be read as a pair — the leak this footer must
 * never spring is an organization name reaching a signed-out guest, and the two
 * canvases put the two treatments side by side.
 *
 * Unlike `dashboard-header-actions`, a canvas is FAITHFUL here: the sidebar is
 * fixed-width, so nothing about this depends on the page container the way the
 * dashboard's wrapping title row does.
 */
const meta = {
  title: "Composites v1.0/Desktop Shell/Sidebar Account Footer",
  tags: ["deprecated"],
  component: Sidebar,
  parameters: { layout: "fullscreen" },
};

export default meta;

/**
 * A guest: no session. The footer reads "Guest" behind an avatar fallback, and
 * the menu behind it still carries Settings, Diagnostics and Theme — open it on
 * the canvas. An earlier revision replaced the whole dropdown with a bare
 * button, which stranded a signed-out user with no route to Settings at all.
 */
export const Guest = {
  render: () => stage({ signedIn: false }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    // Auth resolves through a real IPC round-trip, so without this the canvas
    // could settle on the signed-in fallback and the story would be a lie that
    // still mounted green in the sweep.
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
  render: () => stage({ signedIn: true }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForText(canvasElement, ORG_NAME);
    assertTextAbsent(canvasElement, GUEST_LABEL);
  },
};

const GUEST_LABEL = "Guest";
const ORG_NAME = "Northwind Engineering";
const ACCOUNT_FALLBACK = "Account";

type Fixture = { signedIn: boolean };

/**
 * The real providers over a stubbed preload bridge, rather than mocked hooks:
 * `useGuestOnboarding` reads the auth status through `DesktopAppCoreProvider`,
 * so stubbing `window.desktopApi` is what exercises the same resolution path the
 * packaged app takes. A story cannot `vi.mock`, which is the other reason to
 * drive it from the bridge. `DesktopFeatureFlagProvider` stays because the
 * sidebar's own gated footer reads the flag port through it.
 */
function installBridge({ signedIn }: Fixture): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getRuntimeStatus: () => Promise.resolve({ isPackaged: false }),
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
        <SidebarProvider>
          <Sidebar activeNav={NavId.Sessions} />
        </SidebarProvider>
      </DesktopFeatureFlagProvider>
    </DesktopAuthProvider>
  );
}
