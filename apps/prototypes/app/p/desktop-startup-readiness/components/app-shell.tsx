"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@repo/design-system/components/ui/breadcrumb";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarNavLinkItem,
  SidebarProvider,
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import {
  BotIcon,
  ChevronsUpDownIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
  SearchIcon,
  SquareCheckIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { StartupFixture } from "../mock";
import { StartupReadinessPanel } from "./startup-readiness-panel";

type StartupAppShellProps = {
  fixture: StartupFixture;
  actions: ReactNode;
  children: ReactNode;
};

const primaryItems = [
  { label: "Dashboard", icon: LayoutDashboardIcon },
  { label: "Inbox", icon: InboxIcon },
] as const;

const artifactItems = [
  { label: "Documents", icon: FileIcon },
  { label: "Issues", icon: SquareCheckIcon },
  { label: "Sessions", icon: HistoryIcon, active: true },
  { label: "Branches", icon: GitBranchIcon },
  { label: "Agents", icon: BotIcon },
] as const;

export function StartupAppShell({
  fixture,
  actions,
  children,
}: StartupAppShellProps) {
  return (
    <SidebarProvider className="h-svh">
      <PrototypeSidebar />
      <SidebarInset>
        <StartupReadinessPanel fixture={fixture} />
        <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="-ml-1 text-muted-foreground" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage>Sessions</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <div className="max-w-full overflow-x-auto">{actions}</div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function PrototypeSidebar() {
  return (
    <Sidebar variant="inset">
      <div className="px-2 pt-2.5">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search"
            className="h-8 rounded-full bg-transparent pr-3 pl-8 text-xs shadow-none"
            placeholder="Search"
            readOnly
          />
        </div>
      </div>
      <SidebarContent className="gap-1 pt-2">
        <SidebarGroup className="p-1">
          <SidebarMenu className="gap-0">
            {primaryItems.map((item) => (
              <SidebarItem item={item} key={item.label} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarCollapsibleSection title="Artifacts">
          <SidebarMenu className="gap-0">
            {artifactItems.map((item) => (
              <SidebarItem item={item} key={item.label} />
            ))}
          </SidebarMenu>
        </SidebarCollapsibleSection>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip="ClosedLoop">
              <Avatar className="size-7 rounded-md">
                <AvatarFallback className="rounded-md bg-primary text-primary-foreground text-xs">
                  C
                </AvatarFallback>
              </Avatar>
              <span className="truncate font-medium">ClosedLoop</span>
              <ChevronsUpDownIcon className="ml-auto size-4 opacity-60" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function SidebarItem({
  item,
}: {
  item: {
    label: string;
    icon: typeof LayoutDashboardIcon;
    active?: boolean;
  };
}) {
  const Icon = item.icon;
  return (
    <SidebarNavLinkItem
      className="text-sm"
      icon={<Icon />}
      isActive={item.active}
      title={item.label}
      tooltip={item.label}
    />
  );
}
