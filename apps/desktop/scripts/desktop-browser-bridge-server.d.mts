import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";

export function startDesktopBrowserBridgeServer(options: {
  allowedOrigin: string;
  clientToken: string;
  hostToken: string;
  httpServer: HttpServer | HttpsServer;
  /** Defaults to `Date.now`; injected so a suite can drive the rejoin window. */
  now?: () => number;
}): {
  close: () => Promise<void>;
};
