import { UserIdentifier } from "@repo/analytics/components/user-identifier";
import { MobileBottomNav } from "@repo/app/shared/components/mobile-bottom-nav";
import { auth, currentUser } from "@repo/auth/server";
import {
  SIDEBAR_COOKIE_NAME,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { EngineerTransportBootstrap } from "@/components/engineer/engineer-transport-bootstrap";
import { env } from "@/env";
import { FrontendCaptureController } from "@/lib/frontend-capture/frontend-capture-controller";
import { PreLoopSystemCheckProvider } from "@/lib/system-check/pre-loop-system-check-provider";
import { CollaborationProviderWrapper } from "./components/collaboration-provider-wrapper";
import { CommandPalette } from "./components/command-palette";
import { OnboardingGuard } from "./components/onboarding-guard";
import { GlobalSidebar } from "./components/sidebar";
import { WorkspaceAuthGuard } from "./components/workspace-auth-guard";

type AppLayoutProperties = {
  readonly children: ReactNode;
};

const AppLayout = async ({ children }: AppLayoutProperties) => {
  // Parallelize independent async operations to eliminate waterfalls
  const [{ redirectToSignUp }, user, cookieStore, headersList] =
    await Promise.all([auth(), currentUser(), cookies(), headers()]);

  if (!user) {
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
  const host =
    headersList.get("x-forwarded-host") ?? headersList.get("host") ?? "";
  const sidebarEnvBadge =
    host.startsWith("localhost:") || host.startsWith("127.0.0.1:")
      ? (env.NEXT_PUBLIC_API_URL ?? "localhost")
      : null;

  return (
    <CollaborationProviderWrapper>
      <SidebarProvider defaultOpen={sidebarDefaultOpen}>
        <GlobalSidebar envBadge={sidebarEnvBadge}>
          {/* Outside OnboardingGuard: that guard unmounts its subtree on every
              onboarding-status refetch (isFetching), which would tear down and
              restart capture, splitting staff session replay into segments. */}
          <FrontendCaptureController />
          <OnboardingGuard>
            <UserIdentifier />
            <CommandPalette />
            <EngineerTransportBootstrap />
            <PreLoopSystemCheckProvider>
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
            </PreLoopSystemCheckProvider>
          </OnboardingGuard>
        </GlobalSidebar>
      </SidebarProvider>
    </CollaborationProviderWrapper>
  );
};

export default AppLayout;
