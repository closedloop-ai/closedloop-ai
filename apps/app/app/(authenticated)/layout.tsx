import { UserIdentifier } from "@repo/analytics/components/user-identifier";
import { auth, currentUser } from "@repo/auth/server";
import {
  SIDEBAR_COOKIE_NAME,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import { secure } from "@repo/security";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { EngineerTransportBootstrap } from "@/components/engineer/engineer-transport-bootstrap";
import { env } from "@/env";
import { CollaborationProviderWrapper } from "./components/collaboration-provider-wrapper";
import { DragHandlerWrapper } from "./components/drag-handler-wrapper";
import { NotificationsProvider } from "./components/notifications-provider";
import { GlobalSidebar } from "./components/sidebar";
import { SystemCheckBootstrap } from "./components/system-check-bootstrap";

type AppLayoutProperties = {
  readonly children: ReactNode;
};

const AppLayout = async ({ children }: AppLayoutProperties) => {
  // Parallelize independent async operations to eliminate waterfalls
  const [, { redirectToSignIn }, user, cookieStore, headersList] =
    await Promise.all([
      // Security check runs in parallel (result unused but must complete)
      env.ARCJET_KEY ? secure(["CATEGORY:PREVIEW"]) : Promise.resolve(),
      auth(),
      currentUser(),
      cookies(),
      headers(),
    ]);

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
      <DragHandlerWrapper>
        <NotificationsProvider userId={user.id}>
          <SidebarProvider defaultOpen={sidebarDefaultOpen}>
            <GlobalSidebar envBadge={sidebarEnvBadge}>
              <UserIdentifier />
              <EngineerTransportBootstrap />
              <SystemCheckBootstrap />

              <div className="flex h-full max-h-full flex-col overflow-hidden">
                {children}
              </div>
            </GlobalSidebar>
          </SidebarProvider>
        </NotificationsProvider>
      </DragHandlerWrapper>
    </CollaborationProviderWrapper>
  );
};

export default AppLayout;
