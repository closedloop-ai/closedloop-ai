import { createServer, type Server } from "node:http";
import next from "next";
import { initDesktopGatewaySocketServer } from "./desktop-gateway-socket-server";

/**
 * The API server bootstrap, shared by both entrypoints.
 *
 * Extracted from `server.ts` so the two entrypoints can differ in what they
 * IMPORT rather than only in what they do (davetho, #6048): `server.ts` is
 * the production command (`server:start`, and the Dockerfile CMD), and
 * `server-dev.ts` is the one that additionally starts the dev cron scheduler.
 * Keeping the scheduler out of production means keeping it out of production's
 * import graph, which a runtime guard alone cannot do.
 *
 * Importing this module starts nothing; call it.
 */

export type ApiServerHandle = {
  readonly server: Server;
  /**
   * The port actually bound, read from `server.address()` — not the configured
   * one, which is `0` under an ephemeral-port bind and would send any consumer
   * to `:0`.
   */
  readonly port: number;
};

export function startApiServer(): Promise<ApiServerHandle> {
  const dev = isNextDevMode(process.env);
  const hostname = process.env.HOST ?? "0.0.0.0";
  const port = Number.parseInt(process.env.PORT ?? "3002", 10);

  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();

  return app.prepare().then(
    () =>
      new Promise<ApiServerHandle>((resolve, reject) => {
        const server = createServer((request, response) => {
          handle(request, response).catch((error) => {
            console.error("Failed handling API request", error);
            if (response.headersSent) {
              response.end();
            } else {
              response.statusCode = 500;
              response.end("Internal Server Error");
            }
          });
        });

        initDesktopGatewaySocketServer(server);

        // Without this the promise can only ever RESOLVE, so a bind failure
        // (EADDRINUSE is the everyday one) reaches no `.catch` and leaves every
        // caller pending forever. The pre-split `server.ts` had the same gap and
        // survived it only because an unhandled `'error'` event crashes the
        // process — an exported "resolves when ready" API should not depend on
        // that (#6048 review).
        const onListenError = (error: Error) => {
          reject(error);
        };
        server.once("error", onListenError);

        server.listen(port, hostname, () => {
          server.removeListener("error", onListenError);
          const address = server.address();
          const boundPort =
            typeof address === "object" && address !== null
              ? address.port
              : port;
          // Keep output aligned with Next default readiness log.
          console.log(`> Ready on http://${hostname}:${boundPort}`);
          resolve({ server, port: boundPort });
        });
      })
  );
}

/**
 * Whether Next runs in DEVELOPMENT mode — compiling routes on demand — rather
 * than serving the `.next` build.
 *
 * ISS-10335 made this an explicit development check instead of `!== "production"`.
 * Both shipped entrypoints are unchanged by that: `server:start` runs under
 * `NODE_ENV=production` and `server:dev` under `NODE_ENV=development`. What it
 * buys is the third case — the containerized Clerk-free API runs the SAME built
 * image under `NODE_ENV=test`, because `AUTH_MODE=local_trusted` refuses to
 * activate while `NODE_ENV` is production (packages/auth/auth-mode.ts). Under
 * the old negation that container asked Next to start a dev server with no dev
 * toolchain and a prebuilt `.next` sitting beside it.
 */
export function isNextDevMode(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "development";
}
