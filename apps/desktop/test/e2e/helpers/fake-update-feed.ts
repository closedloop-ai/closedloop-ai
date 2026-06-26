/**
 * Local fixture "update feed" for the FEA-2099 desktop auto-update e2e.
 *
 * Stands up a localhost HTTP server that serves electron-updater generic-
 * provider metadata — `latest-mac.yml` / `latest.yml` / `latest-linux.yml` —
 * advertising a version strictly newer than the running app, plus a dummy
 * artifact whose `sha512` + `size` match the metadata. No real release server,
 * no network, no code-signing.
 *
 * The desktop main process is pointed at this server via the
 * `CL_DESKTOP_FAKE_UPDATE_FEED` env seam (see src/main/fake-update-feed.ts).
 * electron-updater's real `checkForUpdates()` fetches and parses the channel
 * file from here, so `update-available` fires for real; the download→ready
 * transition is then driven deterministically in main (autoDownload is off in
 * fake-feed mode) so the test stays hermetic across OSes.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/** Version advertised by the fixture feed. Must be > the app's package version. */
export const FAKE_FEED_UPDATE_VERSION = "99.0.0";

/** Dummy artifact filename advertised in the channel metadata. */
const FAKE_ARTIFACT_NAME = "Closedloop-99.0.0-fake.zip";

export type FakeUpdateFeed = {
  /** Base URL (e.g. http://127.0.0.1:54321) to pass as CL_DESKTOP_FAKE_UPDATE_FEED. */
  url: string;
  /** Number of channel-file (`*.yml`) requests served — proves the feed was hit. */
  channelRequestCount: () => number;
  /** Stop the server and release the port. */
  close: () => Promise<void>;
};

/**
 * Build the YAML body of an electron-updater channel file for a single dummy
 * artifact. Hand-rolled (no yaml dep) — the schema is small and stable.
 */
function buildChannelYml(
  version: string,
  artifactName: string,
  sha512: string,
  size: number
): string {
  // releaseDate must be ISO; electron-updater tolerates any parseable date.
  const releaseDate = new Date("2099-01-01T00:00:00.000Z").toISOString();
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${artifactName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${artifactName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}

/**
 * Start the fixture feed server on an ephemeral localhost port.
 *
 * Serves every `*.yml` channel file (mac/linux/win) with the same metadata and
 * the dummy artifact, so the test runs on any host OS.
 */
export async function startFakeUpdateFeed(): Promise<FakeUpdateFeed> {
  // A few KB of deterministic bytes is enough; electron-updater validates
  // size + sha512 against the metadata, not the contents.
  const artifact = Buffer.alloc(4096, 7);
  const sha512 = crypto.createHash("sha512").update(artifact).digest("base64");
  const size = artifact.length;
  const ymlBody = buildChannelYml(
    FAKE_FEED_UPDATE_VERSION,
    FAKE_ARTIFACT_NAME,
    sha512,
    size
  );

  let channelRequests = 0;

  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname.endsWith(".yml")) {
      channelRequests += 1;
      res.writeHead(200, { "content-type": "application/x-yaml" });
      res.end(ymlBody);
      return;
    }
    if (pathname.endsWith(`/${FAKE_ARTIFACT_NAME}`)) {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(size),
      });
      res.end(artifact);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve) => {
    // Bind to loopback only — the feed must never be externally reachable.
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    channelRequestCount: () => channelRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
