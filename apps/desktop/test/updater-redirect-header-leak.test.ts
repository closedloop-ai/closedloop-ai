/**
 * @file updater-redirect-header-leak.test.ts
 * @description ISS-9790 — no header stamped on `autoUpdater.requestHeaders` may
 * cross a cross-origin redirect boundary.
 *
 * WHY THIS EXECUTES THE DEPENDENCY INSTEAD OF DESCRIBING IT. The first pass at
 * this ticket proposed calling `addSensitiveRedirectHeader`, which does not
 * exist at the version the updater resolves, and argued from line numbers about
 * an ordering that runs the other way. Both were reasoned from release notes
 * rather than from the installed tree. So the premise the fix rests on — "the
 * pinned `builder-util-runtime` replays every header except `authorization`" —
 * is pinned HERE, by running it, and the module is resolved through
 * `electron-updater`'s own `require` so it is the SAME instance the updater
 * reads. This tree also contains `9.7.0`, which belongs to electron-builder; a
 * bare specifier from here could reach that one and prove nothing.
 *
 * WHAT THE HARNESS IS, precisely. Two real `node:http` origins on EPHEMERAL
 * ports, a real 302 between them, and the request headers captured on each leg
 * from the socket. The transport is `node:http` rather than Electron's
 * `net` — `ElectronHttpExecutor` cannot be constructed outside a packaged app —
 * but the hop decision under test is `HttpExecutor.prepareRedirectUrlOptions`,
 * the one function BOTH executors call for it (`electronHttpExecutor.js`
 * `addRedirectHandlers`, `httpExecutor.js:142`). Only "do we follow" is local.
 * This proves nothing about Electron's transport, and does not claim to; the
 * packaged end is `test/e2e/auto-update-flow.spec.ts`.
 *
 * THE POSITIVE CONTROL IS THE POINT. An absence assertion against a client that
 * sent nothing at all passes trivially, so every case below asserts a header
 * PRESENT on the leg it should reach before asserting one absent on the leg it
 * should not.
 */
import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import { createRequire } from "node:module";
import { narrowDesktopUpdaterHeadersForRedirect } from "@repo/api/src/types/desktop-client-attribution";
import { afterAll, beforeAll, describe, test } from "vitest";

/**
 * Written out, never read off the contract module — a test that derives its
 * expectation from the constant it polices agrees with a rename it should have
 * caught.
 */
const COMPUTE_TARGET_ID_HEADER = "x-desktop-compute-target-id";
const CLIENT_VERSION_HEADER = "x-desktop-client-version";
const AUTHORIZATION_HEADER = "authorization";

/** Synthetic throughout. No real identifier or credential reaches this file. */
const COMPUTE_TARGET_ID = "01a06a86-56fa-7213-ae2d-3f5fe0932ec5";
const CLIENT_VERSION = "1.24.3";
const SENTINEL_AUTHORIZATION = "Bearer synthetic-sentinel-not-a-credential";

const FEED_PATH = "/feed";
const SAME_ORIGIN_FEED_PATH = "/feed-same-origin";
const ASSET_PATH = "/asset";
const MAX_HOPS = 4;

/** The subset of `RequestOptions` the pinned helpers read and write. */
type RedirectOptions = {
  protocol?: string;
  hostname?: string;
  port?: string;
  path?: string;
  headers?: Record<string, string>;
};

/** The pinned surface this file drives, typed so the `require` is not `any`. */
type PinnedBuilderUtilRuntime = {
  HttpExecutor: {
    prepareRedirectUrlOptions: (
      redirectUrl: string,
      options: RedirectOptions
    ) => RedirectOptions;
  };
  configureRequestUrl: (url: URL, options: RedirectOptions) => void;
  addSensitiveRedirectHeader?: (header: string) => void;
};

/**
 * `builder-util-runtime` as ELECTRON-UPDATER resolves it.
 *
 * `resolve` only locates the entry point; it does not execute `electron-updater`,
 * whose `MacUpdater` touches `require("electron")` at construction (ISS-4514).
 */
const requireFromHere = createRequire(import.meta.url);
const requireFromUpdater = createRequire(
  requireFromHere.resolve("electron-updater")
);
const pinnedRuntime: PinnedBuilderUtilRuntime = requireFromUpdater(
  "builder-util-runtime"
);
const pinnedVersion: string = requireFromUpdater(
  "builder-util-runtime/package.json"
).version;

/** One captured request leg. */
type CapturedLeg = {
  origin: string;
  path: string;
  headers: IncomingHttpHeaders;
};

let captured: CapturedLeg[] = [];
let originA: Server;
let originB: Server;

/**
 * The origins, known only once the kernel has assigned a port.
 *
 * Port 0 rather than two numbers derived from the ticket (whitlockk, #7150): a
 * fixed port makes the whole suite fail with `EADDRINUSE` whenever anything
 * else on the box holds it, and the ticket-derived numbers bought nothing —
 * these servers are ours because this file constructed them, not because of
 * which port they answer on.
 */
let originAUrl = "";
let originBUrl = "";

/** Bind to an ephemeral port and report the origin the kernel actually gave us. */
function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("listening server reported no TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
  });
}

beforeAll(async () => {
  originA = createServer((req, res) => {
    captured.push({
      origin: originAUrl,
      path: req.url ?? "",
      headers: req.headers,
    });
    if (req.url === FEED_PATH) {
      res.writeHead(302, { location: `${originBUrl}${ASSET_PATH}` });
    } else if (req.url === SAME_ORIGIN_FEED_PATH) {
      res.writeHead(302, { location: `${originAUrl}${ASSET_PATH}` });
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
    }
    res.end("ok");
  });
  originB = createServer((req, res) => {
    captured.push({
      origin: originBUrl,
      path: req.url ?? "",
      headers: req.headers,
    });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  originAUrl = await listen(originA);
  originBUrl = await listen(originB);
});

afterAll(async () => {
  await close(originA);
  await close(originB);
});

function sendOnce(options: RedirectOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ ...options, method: "GET" }, (response) => {
      // Drain, or the socket stays open and `server.close` never settles.
      response.resume();
      resolve(response);
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * Walk a redirect chain, handing every hop to the PINNED
 * `prepareRedirectUrlOptions` — which is what decides the next request's
 * headers, and the only part of this that is under test.
 */
async function followWithPinnedRedirectHandling(
  startUrl: string,
  headers: Record<string, string>
): Promise<void> {
  let options: RedirectOptions = { headers: { ...headers } };
  pinnedRuntime.configureRequestUrl(new URL(startUrl), options);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const response = await sendOnce(options);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status < 300 || status >= 400 || location === undefined) {
      return;
    }
    options = pinnedRuntime.HttpExecutor.prepareRedirectUrlOptions(
      location,
      options
    );
  }
  throw new Error(`redirect chain did not terminate within ${MAX_HOPS} hops`);
}

/** The captured leg for one origin and path, or a throw naming what did arrive. */
function leg(origin: string, path: string): IncomingHttpHeaders {
  const match = captured.find((c) => c.origin === origin && c.path === path);
  if (!match) {
    // A throw rather than an assertion because this runs outside a test body;
    // it fails the case identically and keeps the diagnostic.
    throw new Error(
      `no request reached ${origin}${path}; captured ${JSON.stringify(
        captured.map((c) => `${c.origin}${c.path}`)
      )}`
    );
  }
  return match.headers;
}

function resetCaptured(): void {
  captured = [];
}

describe("what the pinned builder-util-runtime does on a real cross-origin hop", () => {
  test("replays every header onto the new origin, deleting only authorization", async () => {
    resetCaptured();

    await followWithPinnedRedirectHandling(`${originAUrl}${FEED_PATH}`, {
      [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: CLIENT_VERSION,
      [AUTHORIZATION_HEADER]: SENTINEL_AUTHORIZATION,
    });

    // Positive control: all three really were on the wire for leg A, so every
    // absence below is a removal and not an empty pipe.
    const first = leg(originAUrl, FEED_PATH);
    assert.equal(first[COMPUTE_TARGET_ID_HEADER], COMPUTE_TARGET_ID);
    assert.equal(first[CLIENT_VERSION_HEADER], CLIENT_VERSION);
    assert.equal(first[AUTHORIZATION_HEADER], SENTINEL_AUTHORIZATION);

    // The hazard, executed rather than asserted from a changelog: the opaque
    // per-install id is handed to an origin that was never meant to see it.
    const second = leg(originBUrl, ASSET_PATH);
    assert.equal(second[COMPUTE_TARGET_ID_HEADER], COMPUTE_TARGET_ID);
    assert.equal(second[CLIENT_VERSION_HEADER], CLIENT_VERSION);
    assert.equal(
      second[AUTHORIZATION_HEADER],
      undefined,
      "the one header this version strips is no longer being stripped"
    );
  });

  test("a same-origin hop keeps everything, authorization included", async () => {
    resetCaptured();

    await followWithPinnedRedirectHandling(
      `${originAUrl}${SAME_ORIGIN_FEED_PATH}`,
      {
        [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID,
        [AUTHORIZATION_HEADER]: SENTINEL_AUTHORIZATION,
      }
    );

    const first = leg(originAUrl, SAME_ORIGIN_FEED_PATH);
    assert.equal(first[COMPUTE_TARGET_ID_HEADER], COMPUTE_TARGET_ID);

    // The negative leg. A fix that stripped on every redirect rather than every
    // CROSS-ORIGIN redirect would break the updater in the other direction, and
    // this is the assertion that would catch it.
    const second = leg(originAUrl, ASSET_PATH);
    assert.equal(second[COMPUTE_TARGET_ID_HEADER], COMPUTE_TARGET_ID);
    assert.equal(second[AUTHORIZATION_HEADER], SENTINEL_AUTHORIZATION);
  });

  test("a scheme downgrade and a hostname change both count as cross-origin", () => {
    const options = (): RedirectOptions => ({
      protocol: "https:",
      hostname: "updates.example.test",
      path: "/feed",
      headers: { [AUTHORIZATION_HEADER]: SENTINEL_AUTHORIZATION },
    });

    // Same host, downgraded scheme.
    const downgraded = pinnedRuntime.HttpExecutor.prepareRedirectUrlOptions(
      "http://updates.example.test/asset",
      options()
    );
    assert.equal(downgraded.headers?.[AUTHORIZATION_HEADER], undefined);

    // Same scheme, different host.
    const rehosted = pinnedRuntime.HttpExecutor.prepareRedirectUrlOptions(
      "https://objects.example-cdn.test/asset",
      options()
    );
    assert.equal(rehosted.headers?.[AUTHORIZATION_HEADER], undefined);

    // Positive control for the same predicate: an ordinary same-origin hop is
    // untouched, so the two absences above are the predicate firing and not
    // this helper dropping the header unconditionally.
    const sameOrigin = pinnedRuntime.HttpExecutor.prepareRedirectUrlOptions(
      "https://updates.example.test/asset",
      options()
    );
    assert.equal(
      sameOrigin.headers?.[AUTHORIZATION_HEADER],
      SENTINEL_AUTHORIZATION
    );
  });
});

describe("the narrowed header set on a real cross-origin hop", () => {
  test("the id reaches neither origin and the version reaches both", async () => {
    resetCaptured();
    const stamped = {
      [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID,
      [CLIENT_VERSION_HEADER]: CLIENT_VERSION,
    };

    // Positive control on the narrowing itself: the id really is in the input.
    assert.equal(stamped[COMPUTE_TARGET_ID_HEADER], COMPUTE_TARGET_ID);

    await followWithPinnedRedirectHandling(
      `${originAUrl}${FEED_PATH}`,
      narrowDesktopUpdaterHeadersForRedirect(stamped)
    );

    const first = leg(originAUrl, FEED_PATH);
    assert.equal(
      first[CLIENT_VERSION_HEADER],
      CLIENT_VERSION,
      "the narrowed set reached no origin at all, so the absences below prove nothing"
    );
    assert.equal(first[COMPUTE_TARGET_ID_HEADER], undefined);

    const second = leg(originBUrl, ASSET_PATH);
    assert.equal(second[CLIENT_VERSION_HEADER], CLIENT_VERSION);
    assert.equal(second[COMPUTE_TARGET_ID_HEADER], undefined);
  });

  test("a header nothing classified is dropped rather than forwarded", async () => {
    resetCaptured();
    const unclassified = "x-desktop-future-header";

    await followWithPinnedRedirectHandling(
      `${originAUrl}${FEED_PATH}`,
      narrowDesktopUpdaterHeadersForRedirect({
        [unclassified]: "whatever-the-next-person-adds",
        [CLIENT_VERSION_HEADER]: CLIENT_VERSION,
      })
    );

    const first = leg(originAUrl, FEED_PATH);
    assert.equal(first[CLIENT_VERSION_HEADER], CLIENT_VERSION);
    assert.equal(
      first[unclassified],
      undefined,
      "fail-closed is what stops this ticket recurring; an unclassified header got through"
    );
    assert.equal(leg(originBUrl, ASSET_PATH)[unclassified], undefined);
  });
});

describe("the removal condition for this mechanism", () => {
  test("the pinned builder-util-runtime still has no sensitive-header seam", () => {
    assert.equal(
      pinnedRuntime.addSensitiveRedirectHeader,
      undefined,
      `builder-util-runtime ${pinnedVersion} now exports addSensitiveRedirectHeader. ` +
        "ISS-9790 chose the local narrowing BECAUSE that seam was unreachable; with it " +
        "reachable, register each FirstPartyOnly header with it and re-scope the narrowing " +
        "to whatever it still does not cover (it strips per hop; the narrowing removes " +
        "the header from the download leg entirely, which also covers a retry)."
    );
  });
});
