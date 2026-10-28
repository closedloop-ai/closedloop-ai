"use client";

import { useEffect, useSyncExternalStore } from "react";

let openModalDialogCount = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getModalDialogOpen(): boolean {
  return openModalDialogCount > 0;
}

/** Whether any `Dialog`, `AlertDialog`, `Sheet` or `Drawer` from this package is open. */
export function useModalDialogOpen(): boolean {
  return useSyncExternalStore(subscribe, getModalDialogOpen, () => false);
}

/**
 * Counts its dialog as open for as long as it is mounted. Each content component
 * renders it inside the Radix `Content`, which Radix mounts only while the dialog
 * is open or playing its exit animation (`Presence`), so mounted means open.
 * `Content` mounts one commit after the dialog opens, because Radix's `Portal`
 * renders on a second pass, so the count trails an opening by that commit.
 */
export function ModalDialogOpenMarker() {
  useEffect(() => {
    openModalDialogCount += 1;
    notify();
    return () => {
      openModalDialogCount -= 1;
      notify();
    };
  }, []);
  return null;
}
