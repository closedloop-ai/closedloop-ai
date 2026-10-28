import { connectDesktopBrowserBridgeClient } from "./desktop-browser-bridge";

bootBrowserRenderer().catch(showBridgeFailure);

async function bootBrowserRenderer(): Promise<void> {
  const desktopApi = await connectDesktopBrowserBridgeClient({
    onHostSlow: showHostStillStarting,
  });
  Object.defineProperty(globalThis.window, "desktopApi", {
    configurable: true,
    enumerable: true,
    value: desktopApi as Window["desktopApi"],
  });
  await import("./main");
}

/**
 * ISS-8248: the wait is open-ended now, so the page must stop claiming to be
 * mid-connection once the host is overdue — the tab still mounts by itself when
 * Electron finally arrives.
 */
function showHostStillStarting(): void {
  const root = globalThis.document.getElementById("root");
  if (!root) {
    return;
  }
  root.setAttribute("role", "status");
  root.textContent =
    "Waiting for Closedloop Desktop to start — this tab will load by itself.";
}

function showBridgeFailure(error: unknown): void {
  const root = globalThis.document.getElementById("root");
  if (!root) {
    return;
  }
  root.setAttribute("role", "alert");
  root.textContent = `Desktop browser bridge unavailable: ${
    error instanceof Error ? error.message : String(error)
  }`;
}
