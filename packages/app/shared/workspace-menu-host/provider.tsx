"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { WorkspaceMenuHostAdapter } from "./workspace-menu-host-adapter";

const WorkspaceMenuHostAdapterContext =
  createContext<WorkspaceMenuHostAdapter | null>(null);

export function WorkspaceMenuHostAdapterProvider({
  adapter,
  children,
}: {
  adapter: WorkspaceMenuHostAdapter;
  children?: ReactNode;
}) {
  return (
    <WorkspaceMenuHostAdapterContext.Provider value={adapter}>
      {children}
    </WorkspaceMenuHostAdapterContext.Provider>
  );
}

/**
 * The host adapter for the surface rendering the workspace menu, or `null` when
 * no provider is mounted.
 *
 * DELIBERATELY UNLIKE `useSettingsHostAdapter`, which falls back to a web
 * default. That fallback is safe because web genuinely has no local device to
 * describe, so the constant IS the true answer. Here there is no true default:
 * one would have to invent an identity, and the menu would then render as a
 * working account control belonging to nobody.
 *
 * It returns `null` rather than throwing because a shared component must not add
 * an unconditional provider requirement — every mount site lacking it, the
 * Storybook preview included, would crash. The menu renders an explicit
 * unavailable state instead, which is neither a crash nor a lie.
 */
export function useWorkspaceMenuHostAdapter(): WorkspaceMenuHostAdapter | null {
  return useContext(WorkspaceMenuHostAdapterContext);
}
