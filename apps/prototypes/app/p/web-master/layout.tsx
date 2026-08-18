import {
  SidebarInset,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import type { ReactNode } from "react";
import { AppSidebar } from "./components/app-sidebar";

// Persistent shell for the master demo: the sidebar survives navigation
// between the combined surfaces; each subpage renders its own header +
// content through PageChrome.
const WebMasterLayout = ({ children }: { children: ReactNode }) => (
  <SidebarProvider className="h-svh">
    <AppSidebar />
    <SidebarInset>{children}</SidebarInset>
  </SidebarProvider>
);

export default WebMasterLayout;
