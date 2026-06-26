import { initDesktopGatewaySocketServer } from "../lib/desktop-gateway-socket-server";

/**
 * Smoke-test the custom Socket.IO gateway entrypoint without starting a server.
 * The gateway runs under tsx outside Next.js, so this catches accidental imports
 * of Next-only `server-only` modules that `next build` does not execute.
 */
if (typeof initDesktopGatewaySocketServer !== "function") {
  throw new Error("Desktop gateway socket server export is unavailable");
}
