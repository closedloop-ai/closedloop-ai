import { auth, currentUser } from "@repo/auth/server";
import {
  SIDEBAR_COOKIE_NAME,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import { secure } from "@repo/security";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { env } from "@/env";
import { AuthGate } from "./components/auth-gate";
import { CollaborationProviderWrapper } from "./components/collaboration-provider-wrapper";
import { DragHandlerWrapper } from "./components/drag-handler-wrapper";
import { NotificationsProvider } from "./components/notifications-provider";
import { GlobalSidebar } from "./components/sidebar";

type AppLayoutProperties = {
  readonly children: ReactNode;
};

const AppLayout = async ({ children }: AppLayoutProperties) => {
  // Parallelize independent async operations to eliminate waterfalls
  const [, { redirectToSignIn }, user, cookieStore] = await Promise.all([
    // Security check runs in parallel (result unused but must complete)
    env.ARCJET_KEY ? secure(["CATEGORY:PREVIEW"]) : Promise.resolve(),
    auth(),
    currentUser(),
    cookies(),
  ]);

  if (!user) {
    return redirectToSignIn();
  }

  const sidebarCookie = cookieStore.get(SIDEBAR_COOKIE_NAME);
  const sidebarDefaultOpen = sidebarCookie
    ? sidebarCookie.value === "true"
    : true;

  return (
    <CollaborationProviderWrapper>
      <DragHandlerWrapper>
        <NotificationsProvider userId={user.id}>
          <SidebarProvider defaultOpen={sidebarDefaultOpen}>
            <GlobalSidebar>
              <AuthGate>
                <div className="flex h-full max-h-full flex-col overflow-hidden">
                  {children}
                </div>
              </AuthGate>
            </GlobalSidebar>
          </SidebarProvider>
        </NotificationsProvider>
      </DragHandlerWrapper>
    </CollaborationProviderWrapper>
  );
};

export default AppLayout;
