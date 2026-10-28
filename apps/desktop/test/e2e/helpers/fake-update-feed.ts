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
 * `CL_DESKTOP_FAKE_UPDATE_FEED` env seam (see src/main/update/fake-update-feed.ts).
 * electron-updater's real `checkForUpdates()` fetches and parses the channel
 * file from here, so `update-available` fires for real; the download→ready
 * transition is then driven deterministically in main (autoDownload is off in
 * fake-feed mode) so the test stays hermetic across OSes.
 *
 * That hermeticity is also this fixture's ceiling: with `autoDownload` off and a
 * dummy artifact, no blockmap is ever fetched and no Range request is ever
 * issued, so nothing here exercises electron-updater's differential download
 * (ISS-10424). Extending it to would mean serving real N-1/N ZIPs plus their
 * blockmaps and letting the native downloader run in the displayless harness.
 * Until then the differential path is verified on the release lane, not in CI —
 * see `apps/desktop/AGENTS.md`.
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
  /**
   * Headers of the channel-file requests served, in arrival order.
   *
   * A count proves a request happened; it says nothing about what the request
   * CARRIED, so a provider that dropped or renamed the ISS-9164 attribution
   * headers would satisfy `channelRequestCount` unchanged (davetho, #6867).
   * Node lower-cases inbound header names, which is what the assertions compare
   * against.
   */
  channelRequestHeaders: () => http.IncomingHttpHeaders[];
  /**
   * Answer every later channel-file request with a 500, so electron-updater's
   * next check fails (ISS-11447). Those requests still count and record headers.
   */
  failChannelRequests: () => void;
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

  const channelHeaders: http.IncomingHttpHeaders[] = [];
  let failChannel = false;

  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname.endsWith(".yml")) {
      channelHeaders.push(req.headers);
      if (failChannel) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("feed unavailable");
        return;
      }
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
    channelRequestCount: () => channelHeaders.length,
    channelRequestHeaders: () => [...channelHeaders],
    failChannelRequests: () => {
      failChannel = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
