import { UserIdentifier } from "@repo/analytics/components/user-identifier";
import { CollaborationProviderWrapper } from "@repo/app/documents/components/collaboration-provider-wrapper";
import { MobileBottomNav } from "@repo/app/shared/components/mobile-bottom-nav";
import { DevToolsOverlay } from "@repo/app/shared/dev-tools/components/dev-tools-overlay";
import { UndoKeybindingLayer } from "@repo/app/undo/components/undo-keybinding-layer";
import { UndoStackProvider } from "@repo/app/undo/hooks/use-undo-stack";
import { auth } from "@repo/auth/server";
import {
  SIDEBAR_COOKIE_NAME,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { env } from "@/env";
import { isUnreachableApiPreviewHost } from "@/lib/api-origin";
import { FrontendCaptureController } from "@/lib/frontend-capture/frontend-capture-controller";
import { ArtifactRoutePrewarm } from "./components/artifact-route-prewarm";
import { CommandPalette } from "./components/command-palette";
import { OnboardingGuard } from "./components/onboarding-guard";
import { GlobalSidebar } from "./components/sidebar";
import { UnreachableApiNotice } from "./components/unreachable-api-notice";
import { WorkspaceAuthGuard } from "./components/workspace-auth-guard";

type AppLayoutProperties = {
  readonly children: ReactNode;
};

const AppLayout = async ({ children }: AppLayoutProperties) => {
  // Parallelize independent async operations to eliminate waterfalls
  // ISS-10335: `userId` comes off the locally verified session JWT. The
  // `currentUser()` this used to await was a Clerk Backend API fetch on every
  // authenticated page load, and it answered the same question `userId` does.
  const [{ redirectToSignUp, userId }, cookieStore, headersList] =
    await Promise.all([auth(), cookies(), headers()]);

  // The `Host` header, and never `x-forwarded-host` (whitlockk PR review). What
  // the check below models is the address the BROWSER is on — that is what
  // `resolveApiOrigin` rewrites client-side, off `window.location.hostname` —
  // and a forwarded host is a different claim, made by whichever hop set it.
  // This branch runs ahead of the sign-up redirect, so honouring that claim
  // would hand the screen to any visitor on the stable address whose request
  // arrived carrying a deployment-hash `x-forwarded-host`.
  const requestHost = headersList.get("host") ?? "";

  // ISS-9797: ahead of the sign-up redirect, because signing in is not a way
  // through. Every client-side read on this address is CORS-blocked whatever
  // the session, so the flow would end on a shell reporting the user's own
  // data as unavailable.
  if (isUnreachableApiPreviewHost(requestHost)) {
    return (
      <UnreachableApiNotice
        host={requestHost}
        stableAppUrl={env.NEXT_PUBLIC_APP_URL}
      />
    );
  }

  if (!userId) {
    // FEA-632: nearly everyone landing on the app unauthenticated is a new
    // user, so default them to sign-up rather than sign-in to avoid the extra
    // click. Clerk's sign-up embed still surfaces the "Already have an account?
    // Sign in" link for returning users.
    return redirectToSignUp();
  }

  const sidebarCookie = cookieStore.get(SIDEBAR_COOKIE_NAME);
  const sidebarDefaultOpen = sidebarCookie
    ? sidebarCookie.value === "true"
    : true;
  // Left on its original derivation deliberately: the badge is a local-dev
  // affordance, not a claim about the user's data, so the forwarded host is an
  // acceptable input here in a way it is not for the branch above.
  const host = headersList.get("x-forwarded-host") ?? requestHost;
  const sidebarEnvBadge =
    host.startsWith("localhost:") || host.startsWith("127.0.0.1:")
      ? (env.NEXT_PUBLIC_API_URL ?? "localhost")
      : null;

  return (
    <CollaborationProviderWrapper>
      <SidebarProvider defaultOpen={sidebarDefaultOpen}>
        <GlobalSidebar envBadge={sidebarEnvBadge}>
          {/* Outside OnboardingGuard: the guard blanks its subtree until the
              first onboarding-status answer arrives (and keeps it unmounted for
              pre-wizard users), which would tear down and restart capture on
              those boundaries, splitting staff session replay into segments. */}
          <FrontendCaptureController />
          {/* Outside OnboardingGuard for the same reason: the page it warms
              cannot start its own reads until the guard has an answer. */}
          <ArtifactRoutePrewarm />
          {/* ISS-12048: outside OnboardingGuard so Dev Tools stay reachable
              while the guard blanks its subtree. Renders nothing unless Dev
              Mode is on. */}
          <DevToolsOverlay />
          <OnboardingGuard>
            {/* ISS-9092: the session undo stack wraps the whole authenticated
                shell because the mutations that will populate it (ISS-9090's
                capture) happen throughout it, and the keybinding layer below
                must resolve the same stack the capture writes to. */}
            <UndoStackProvider>
              <UserIdentifier />
              <CommandPalette />
              <UndoKeybindingLayer />
              {/* Reserve the bottom-nav's rendered height (+ safe-area) below
                `md` so fixed-bar overlap never clips the last row of content;
                `--bottom-nav-height` is the same token the bar sizes itself
                with, so the reservation and the bar cannot drift. Collapses to
                0 at `md+` where the bar is hidden. */}
              <div className="flex h-full max-h-full flex-col overflow-hidden pb-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom))] md:pb-0">
                {/* FEA-3940: a persistent auth failure (401/403 on `/me`) now
                  renders a recovery surface here instead of a blank main
                  region; the sidebar chrome above stays intact. */}
                <WorkspaceAuthGuard>{children}</WorkspaceAuthGuard>
              </div>
              <MobileBottomNav />
            </UndoStackProvider>
          </OnboardingGuard>
        </GlobalSidebar>
      </SidebarProvider>
    </CollaborationProviderWrapper>
  );
};

export default AppLayout;
