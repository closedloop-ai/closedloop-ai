"use client";

import { UserButton } from "@repo/auth/client";
import { ModeToggle } from "@repo/design-system/components/mode-toggle";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@repo/design-system/components/ui/sidebar";
import { cn } from "@repo/design-system/lib/utils";
import { NotificationsTrigger } from "@repo/notifications/components/trigger";
import {
  ChevronRightIcon,
  ClipboardListIcon,
  FileTextIcon,
  InboxIcon,
  LifeBuoyIcon,
  LightbulbIcon,
  MoreHorizontalIcon,
  ScrollTextIcon,
  SendIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Search } from "./search";

type GlobalSidebarProperties = {
  readonly children: ReactNode;
};

const data = {
  user: {
    name: "shadcn",
    email: "m@example.com",
    avatar: "/avatars/shadcn.jpg",
  },
  // Workspace section - matches the design
  workspace: [
    {
      title: "Inbox",
      url: "/inbox",
      icon: InboxIcon,
      badge: 1, // notification count
      disabled: true,
    },
    {
      title: "Initiatives",
      url: "/initiatives",
      icon: LightbulbIcon,
      disabled: true,
    },
    {
      title: "My Documents",
      url: "/my-documents",
      icon: FileTextIcon,
      disabled: true,
    },
    {
      title: "PRD Library",
      url: "/prds",
      icon: ScrollTextIcon,
      disabled: false,
    },
    {
      title: "Implementation Plans",
      url: "/implementation-plans",
      icon: ClipboardListIcon,
      disabled: false,
    },
    {
      title: "Members",
      url: "/members",
      icon: UsersIcon,
      disabled: true,
    },
    {
      title: "More",
      url: "#",
      icon: MoreHorizontalIcon,
      items: [
        {
          title: "Webhooks",
          url: "/webhooks",
          disabled: false,
        },
        {
          title: "Settings",
          url: "/settings",
          disabled: false,
        },
      ],
    },
  ],
  navSecondary: [
    {
      title: "Support",
      url: "#",
      icon: LifeBuoyIcon,
      disabled: true,
    },
    {
      title: "Feedback",
      url: "#",
      icon: SendIcon,
      disabled: true,
    },
  ],
};

export const GlobalSidebar = ({ children }: GlobalSidebarProperties) => {
  const sidebar = useSidebar();

  return (
    <>
      <Sidebar variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <div
                className={cn(
                  "flex h-[36px] items-center overflow-hidden transition-all",
                  sidebar.open ? "px-2" : "justify-center"
                )}
              >
                <span className="font-semibold text-lg">Symphony</span>
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <Search />
        <SidebarContent>
          {/* Workspace Section */}
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarMenu>
              {data.workspace.map((item, index) => (
                <Collapsible
                  asChild
                  defaultOpen={false}
                  id={`workspace-collapsible-${index}`}
                  key={item.title}
                >
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild={!item.disabled}
                      className={cn(
                        item.disabled
                          ? "pointer-events-none cursor-not-allowed opacity-50"
                          : ""
                      )}
                      tooltip={item.title}
                    >
                      {item.disabled ? (
                        <span className="flex items-center gap-2">
                          <item.icon />
                          <span>{item.title}</span>
                          {item.badge ? (
                            <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-muted font-medium text-[10px] text-muted-foreground">
                              {item.badge}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <Link href={item.url}>
                          <item.icon />
                          <span>{item.title}</span>
                          {item.badge ? (
                            <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-primary font-medium text-[10px] text-primary-foreground">
                              {item.badge}
                            </span>
                          ) : null}
                        </Link>
                      )}
                    </SidebarMenuButton>
                    {item.items?.length ? (
                      <>
                        <CollapsibleTrigger asChild>
                          <SidebarMenuAction className="data-[state=open]:rotate-90">
                            <ChevronRightIcon />
                            <span className="sr-only">Toggle</span>
                          </SidebarMenuAction>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {item.items?.map((subItem) => (
                              <SidebarMenuSubItem key={subItem.title}>
                                <SidebarMenuSubButton
                                  asChild={!subItem.disabled}
                                  className={cn(
                                    subItem.disabled
                                      ? "pointer-events-none cursor-not-allowed opacity-50"
                                      : ""
                                  )}
                                >
                                  {subItem.disabled ? (
                                    <span>{subItem.title}</span>
                                  ) : (
                                    <Link href={subItem.url}>
                                      <span>{subItem.title}</span>
                                    </Link>
                                  )}
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </>
                    ) : null}
                  </SidebarMenuItem>
                </Collapsible>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          {/* Secondary Navigation (pushed to bottom) */}
          <SidebarGroup className="mt-auto">
            <SidebarGroupContent>
              <SidebarMenu>
                {data.navSecondary.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild={!item.disabled}
                      className={cn(
                        item.disabled
                          ? "pointer-events-none cursor-not-allowed opacity-50"
                          : ""
                      )}
                    >
                      {item.disabled ? (
                        <span className="flex items-center gap-2">
                          <item.icon />
                          <span>{item.title}</span>
                        </span>
                      ) : (
                        <Link href={item.url}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-2">
              <UserButton
                appearance={{
                  elements: {
                    rootBox: "flex overflow-hidden w-full",
                    userButtonBox: "flex-row-reverse",
                    userButtonOuterIdentifier: "truncate pl-0",
                  },
                }}
                showName
              />
              <div className="flex shrink-0 items-center gap-px">
                <ModeToggle />
                <Button
                  asChild
                  className="shrink-0"
                  size="icon"
                  variant="ghost"
                >
                  <div className="h-4 w-4">
                    <NotificationsTrigger />
                  </div>
                </Button>
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>{children}</SidebarInset>
    </>
  );
};
