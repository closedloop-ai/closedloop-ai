"use client";

import { WorkspaceMenuHostAdapterProvider } from "@repo/app/shared/workspace-menu-host/provider";
import type { ReactNode } from "react";
import { useWebWorkspaceMenuHostAdapter } from "./web-workspace-menu-host-adapter";

/**
 * Mounts the web workspace-menu port.
 *
 * NOT WIRED INTO `app-core-adapters.tsx` BY THIS ISSUE. ISS-8363 owns the port
 * and the component; ISS-8370 owns the production mount, and the provider and
 * the menu have to land together — a provider with no consumer would run Clerk
 * hooks on every authenticated page load for a menu that is not rendered.
 * Mounting this beside `AuthAdapterProvider` is the whole integration.
 */
export function WebWorkspaceMenuHostProvider({
  children,
}: {
  children?: ReactNode;
}) {
  const adapter = useWebWorkspaceMenuHostAdapter();
  return (
    <WorkspaceMenuHostAdapterProvider adapter={adapter}>
      {children}
    </WorkspaceMenuHostAdapterProvider>
  );
}
