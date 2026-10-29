"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";

export type SettingsSlotOverlay = {
  /**
   * Closes the intercepted Settings modal without unmounting the surface behind
   * it — the slot host owns how the URL is put back.
   */
  onDismiss: () => void;
};

/**
 * Published by the slot host ONLY around a slot it is rendering over a live
 * surface (ISS-8370 D2). The intercepted route root reads it to decide its
 * dismissal mode: present means overlay, absent means there is nothing behind
 * the modal and a dismiss is a real navigation. The full page never sees it,
 * because the host renders `children` outside this provider.
 */
export function SettingsSlotOverlayProvider({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ onDismiss }), [onDismiss]);
  return (
    <SettingsSlotOverlayContext value={value}>
      {children}
    </SettingsSlotOverlayContext>
  );
}

export function useSettingsSlotOverlay(): SettingsSlotOverlay | null {
  return useContext(SettingsSlotOverlayContext);
}

const SettingsSlotOverlayContext = createContext<SettingsSlotOverlay | null>(
  null
);
