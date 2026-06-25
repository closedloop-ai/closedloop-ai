import { useEffect, useState } from "react";

const READY_POLL_MS = 1500;

function parseDashboardReady(status: unknown): boolean {
  if (typeof status !== "object" || status === null) {
    return false;
  }
  return (status as { dashboardReady?: unknown }).dashboardReady === true;
}

/**
 * Polls the main-process runtime status until the initial collector import has
 * completed, signalling that the local-first Dashboard analytics are ready.
 * Stops polling once ready. Defaults to "not ready" until the first response,
 * so the sidebar shows the Dashboard nav item as "still preparing".
 */
export function useDashboardReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) {
      return;
    }
    let cancelled = false;
    const poll = () => {
      window.desktopApi
        .getRuntimeStatus()
        .then((status) => {
          if (!cancelled && parseDashboardReady(status)) {
            setReady(true);
          }
        })
        .catch(() => undefined);
    };
    poll();
    const id = window.setInterval(poll, READY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [ready]);
  return ready;
}
