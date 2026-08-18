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
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import { type AppRoute, routeTitles } from "../app-mock";

/**
 * Slim top chrome: sidebar trigger and the page breadcrumb, plus the user
 * avatar once an account exists. The dashboard's working controls (Local pill,
 * range, scope, Tour, Sign Up) live on the page title row, mirroring the
 * desktop app.
 */
export const AppHeader = ({
  route,
  signedUp,
}: {
  route: AppRoute;
  signedUp: boolean;
}) => (
  <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-border border-b px-4">
    <div className="flex min-w-0 items-center gap-2">
      <SidebarTrigger />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>{routeTitles[route]}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </div>
    {signedUp ? (
      <Avatar className="size-6">
        <AvatarFallback className="bg-primary text-primary-foreground text-xs">
          YU
        </AvatarFallback>
      </Avatar>
    ) : null}
  </header>
);
