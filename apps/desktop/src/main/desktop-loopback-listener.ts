import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

/**
 * Ephemeral loopback callback listener for the desktop loopback OAuth flow
 * (FEA-2525 / PLN-843 Amendment 1, security criterion #6). The web authorize
 * page 302s the system browser to this server's `redirect_uri` carrying the
 * one-time `code` + `state`.
 *
 * Security posture:
 * - Binds `127.0.0.1` ONLY (never `0.0.0.0`) on an OS-assigned ephemeral port.
 * - Serves only the callback path; every other path is a bare 404.
 * - Alive only for the duration of one sign-in; {@link DesktopLoopbackListener.close}
 *   force-closes keep-alive sockets so the port is released promptly.
 * - Carries no secret itself: the code is inert without the desktop-held PKCE
 *   verifier + device key, and `state` is validated by the caller.
 */

const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/cb";
const CALLBACK_HTML =
  '<!doctype html><meta charset="utf-8"><title>Closedloop</title>' +
  '<body style="font-family:system-ui;padding:2rem">' +
  "<p>You can close this tab and return to the Closedloop desktop app.</p>";

/** The `code`/`state` query params delivered to the callback path (either may be absent). */
export type LoopbackCallback = {
  code: string | null;
  state: string | null;
};

export type DesktopLoopbackListener = {
  /** The `http://127.0.0.1:<port>/cb` URL to hand to the authorize request. */
  redirectUri: string;
  /**
   * Resolve with the callback params once the browser hits the callback path,
   * or `null` if `signal` aborts first (caller timeout or cancellation).
   */
  waitForCallback: (signal: AbortSignal) => Promise<LoopbackCallback | null>;
  /** Idempotently stop the server and release the port. */
  close: () => Promise<void>;
};

type StartLoopbackListenerOptions = {
  /** Test seam — defaults to `node:http` `createServer`. */
  createServerImpl?: typeof createServer;
};

/** Start the loopback listener bound to `127.0.0.1` on an ephemeral port. */
export function startDesktopLoopbackListener(
  options: StartLoopbackListenerOptions = {}
): Promise<DesktopLoopbackListener> {
  const createServerFn = options.createServerImpl ?? createServer;

  return new Promise((resolve, reject) => {
    let received: LoopbackCallback | null = null;
    let deliver: ((callback: LoopbackCallback) => void) | null = null;

    const server = createServerFn((req, res) => {
      const callback = handleRequest(req, res);
      if (!callback || received) {
        return;
      }
      // Capture the first callback only; wake a waiter or store it for a later
      // waitForCallback (whichever order they happen in).
      received = callback;
      deliver?.(callback);
    });

    server.once("error", reject);

    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("loopback listener bound no port"));
        return;
      }
      const redirectUri = `http://${LOOPBACK_HOST}:${address.port}${CALLBACK_PATH}`;

      const waitForCallback = (
        signal: AbortSignal
      ): Promise<LoopbackCallback | null> => {
        if (received) {
          return Promise.resolve(received);
        }
        if (signal.aborted) {
          return Promise.resolve(null);
        }
        return new Promise((resolveWait) => {
          const onAbort = () => {
            deliver = null;
            resolveWait(null);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          deliver = (callback) => {
            signal.removeEventListener("abort", onAbort);
            resolveWait(callback);
          };
        });
      };

      const close = (): Promise<void> =>
        new Promise((resolveClose) => {
          // Drop lingering keep-alive sockets so the ephemeral port frees up
          // immediately after the one callback (Node ≥18.2).
          server.closeAllConnections?.();
          server.close(() => resolveClose());
        });

      resolve({ redirectUri, waitForCallback, close });
    });
  });
}

/** Serve the request; return the callback params iff it hit the callback path. */
function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): LoopbackCallback | null {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
  } catch {
    res.writeHead(400, { Connection: "close" }).end();
    return null;
  }
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { Connection: "close" }).end();
    return null;
  }
  res
    .writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      Connection: "close",
    })
    .end(CALLBACK_HTML);
  return {
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
  };
}
