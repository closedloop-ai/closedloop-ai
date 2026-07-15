import { UserIdentifier } from "@repo/analytics/components/user-identifier";
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
import { SystemCheckBootstrap } from "./components/system-check-bootstrap";

type AppLayoutProperties = {
  readonly children: ReactNode;
};

const AppLayout = async ({ children }: AppLayoutProperties) => {
  // Parallelize independent async operations to eliminate waterfalls
  const [{ redirectToSignIn }, user, cookieStore, headersList] =
    await Promise.all([auth(), currentUser(), cookies(), headers()]);

  if (!user) {
    return redirectToSignIn();
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
              <SystemCheckBootstrap />
              <div className="flex h-full max-h-full flex-col overflow-hidden">
                {children}
              </div>
            </PreLoopSystemCheckProvider>
          </OnboardingGuard>
        </GlobalSidebar>
      </SidebarProvider>
    </CollaborationProviderWrapper>
  );
};

export default AppLayout;
