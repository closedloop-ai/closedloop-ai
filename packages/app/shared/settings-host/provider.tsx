"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { SettingsHostAdapter } from "./settings-host-adapter";
import { webSettingsHostAdapter } from "./settings-host-adapter";

const SettingsHostAdapterContext = createContext<SettingsHostAdapter | null>(
  null
);

export function SettingsHostAdapterProvider({
  adapter,
  children,
}: {
  adapter: SettingsHostAdapter;
  children?: ReactNode;
}) {
  return (
    <SettingsHostAdapterContext.Provider value={adapter}>
      {children}
    </SettingsHostAdapterContext.Provider>
  );
}

/**
 * The host adapter for the surface rendering Settings.
 *
 * Falls back to {@link webSettingsHostAdapter} rather than throwing, because the
 * web shell deliberately mounts no provider: there is no local host to describe
 * and the default has no local call path. A Storybook or unit mount without a
 * provider therefore behaves exactly as the web app does, and the desktop
 * renderer's provider is pinned by its own wiring test.
 */
export function useSettingsHostAdapter(): SettingsHostAdapter {
  return useContext(SettingsHostAdapterContext) ?? webSettingsHostAdapter;
}
