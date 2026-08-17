import { useSyncExternalStore } from "react";

/**
 * Renderer connectivity as a reactive value, for the app-core mode rule
 * (PLN-1138 D-E). Chromium keeps `navigator.onLine` current in the Electron
 * renderer and fires `online`/`offline` on every transition, so this needs no
 * IPC to main.
 *
 * Coarse by construction — see {@link DesktopAppCoreModeInput.isOnline}: it
 * reports interface-level connectivity, not cloud-API reachability. That is the
 * right trade for picking a stack (a captive portal or a down API surfaces as a
 * normal request error either way) but it is not a health check.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeToOnlineStatus, getOnlineSnapshot);
}

function subscribeToOnlineStatus(onStoreChange: () => void): () => void {
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);
  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}

function getOnlineSnapshot(): boolean {
  return navigator.onLine;
}
