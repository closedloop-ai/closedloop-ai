/**
 * A localhost stand-in for the CloudRelay `/desktop-gateway` namespace, used to
 * drive the real `CloudSocketService` in a launched app.
 *
 * ISS-6126: the cloud answers a refused `desktop.hello` with
 * `desktop.hello.nack` and then closes the socket. Proving the reason reaches
 * the user needs the whole chain — socket → CloudSocketService → runtime-status
 * IPC → preload → Settings renderer — not a fake at each end.
 */

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { Server as SocketIoServer } from "socket.io";

export type FakeCloudRelay = {
  close: () => Promise<void>;
  /** How many `desktop.hello` frames the relay has answered. */
  helloCount: () => number;
  origin: string;
};

/**
 * Starts a relay that refuses every hello with `reason`, mirroring the API's
 * own ordering: emit the nack, then close the connection.
 */
export async function startHelloNackRelay(
  reason: string
): Promise<FakeCloudRelay> {
  let helloCount = 0;
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const socketServer = new SocketIoServer(server, { serveClient: false });
  socketServer.of("/desktop-gateway").on("connection", (socket) => {
    socket.on("desktop.hello", () => {
      helloCount += 1;
      socket.emit("desktop.hello.nack", { reason });
      socket.disconnect(true);
    });
  });
  const origin = await listen(server);
  return {
    origin,
    helloCount: () => helloCount,
    // `SocketIoServer.close` also closes the http server it was attached to, so
    // closing that separately would call back with ERR_SERVER_NOT_RUNNING.
    close: () => closeSocketServer(socketServer),
  };
}

/**
 * Points a launched app's cloud socket at `relayOrigin` and turns the cloud
 * connection on. Merges into whatever `seedE2eDesktopSettings` already wrote.
 */
export function seedCloudRelaySettings(
  userDataDir: string,
  relayOrigin: string
): void {
  const settingsPath = path.join(userDataDir, "desktop-settings.json");
  const raw = fs.existsSync(settingsPath)
    ? (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<
        string,
        unknown
      >)
    : {};
  const webAppOrigin = "http://127.0.0.1:3000";
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        ...raw,
        cloudConnectionEnabled: true,
        apiOrigin: relayOrigin,
        relayOrigin,
        webAppOrigin,
        activeConfigId: "hello-nack-e2e-profile",
        savedConfigs: [
          {
            id: "hello-nack-e2e-profile",
            name: "Hello Nack E2E",
            apiOrigin: relayOrigin,
            relayOrigin,
            webAppOrigin,
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake cloud relay did not bind to a TCP port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeSocketServer(socketServer: SocketIoServer): Promise<void> {
  await new Promise<void>((resolve) => {
    socketServer.close(() => resolve());
  });
}
