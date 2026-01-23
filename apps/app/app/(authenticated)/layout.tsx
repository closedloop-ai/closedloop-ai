import { auth, currentUser } from "@repo/auth/server";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { secure } from "@repo/security";
import type { ReactNode } from "react";
import { env } from "@/env";
import { NotificationsProvider } from "./components/notifications-provider";
import { GlobalSidebar } from "./components/sidebar";

type AppLayoutProperties = {
  readonly children: ReactNode;
};

const AppLayout = async ({ children }: AppLayoutProperties) => {
  // Parallelize independent async operations to eliminate waterfalls
  const [, { redirectToSignIn }, user] = await Promise.all([
    // Security check runs in parallel (result unused but must complete)
    env.ARCJET_KEY ? secure(["CATEGORY:PREVIEW"]) : Promise.resolve(),
    auth(),
    currentUser(),
  ]);

  if (!user) {
    return redirectToSignIn();
  }

  return (
    <NotificationsProvider userId={user.id}>
      <SidebarProvider>
        <GlobalSidebar>
          <div className="flex h-dvh max-h-dvh flex-col overflow-hidden">
            {children}
          </div>
        </GlobalSidebar>
      </SidebarProvider>
    </NotificationsProvider>
  );
};

export default AppLayout;
