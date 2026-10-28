/**
 * @file desktop-feature-flags-preload-hop.test.ts
 * @description ISS-8024 (davetho review,
 * `desktop-posthog-flag-cutover.test.tsx:316`): the cutover suite installs a
 * hand-written `window.desktopApi`, so it never exercised the production chain
 * from `createDesktopApi().getDesktopFeatureFlags` to the shared IPC channel, to
 * the registered main handler, to the main-process API client and back. A typo
 * in the preload method, a handler registered on a channel the renderer never
 * invokes, or a broken envelope unwrap all left that suite green while the
 * launched app received no assignment at all.
 *
 * So this drives the whole main-side chain in one pass: `createDesktopApi` → an
 * `ipcRenderer` stand-in wired to the REAL registered `ipcMain` handler → the
 * REAL `fetchDesktopFeatureFlags` → a stubbed `globalThis.fetch` standing in for
 * the API. The only test doubles are the two process edges (the IPC transport
 * and the network); every production module between them is the shipped one.
 *
 * ACCEPTED BOUNDARY, stated rather than implied: this stops at the preload
 * method. It does not mount the renderer, so the last hop — provider reads
 * `window.desktopApi.getDesktopFeatureFlags` and gates a route on the result —
 * is covered by the cutover suite against a stubbed bridge, and only a packaged
 * desktop E2E would join the two halves in one process. What that leaves
 * uncovered is narrow: the two suites agree on the METHOD NAME
 * `getDesktopFeatureFlags` and on the assignment shape, both of which are typed
 * by `DesktopFeatureFlagAssignment` and asserted here against the real preload
 * surface.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { publishAnonymousDesktopFeatureFlagsSource } from "../src/main/auth/desktop-feature-flags-client.js";
import { registerDesktopIdentityIpcHandlers } from "../src/main/ipc/desktop-identity-ipc.js";
import { registerE2eFeatureFlagSeedIpcHandler } from "../src/main/ipc/e2e-feature-flag-seed-ipc.js";
import { createDesktopApi } from "../src/main/preload-common.js";
import { DesktopFeatureFlagsIpcChannel } from "../src/shared/desktop-feature-flags-channel.js";

const TRUSTED_SENDER = { id: "trusted-renderer" };
const API_ORIGIN = "https://api.closedloop.test";
const ACCESS_TOKEN = "access-token";
const ASSIGNMENT = {
  userId: "user_desktop_1",
  resolved: true,
  flags: { "agents-nav": true, "branches-cohort-transparency": false },
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  publishAnonymousDesktopFeatureFlagsSource(null);
});

/**
 * Everything between the two process edges, wired the way
 * `desktop-ipc-registration.ts` wires it.
 */
function createHop({
  isTrustedSender = (sender: unknown) => sender === TRUSTED_SENDER,
  body = JSON.stringify({ success: true, data: ASSIGNMENT }),
  status = 200,
  getAccountAdmission = undefined as
    | (() => {
        userId: string;
        organizationId: string;
        generation: number;
      } | null)
    | undefined,
} = {}) {
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  const invokedChannels: string[] = [];
  const requests: { url: string; init: RequestInit }[] = [];

  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;

  registerDesktopIdentityIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender,
      getAccessToken: () => Promise.resolve<string | null>(ACCESS_TOKEN),
      getApiOrigin: () => API_ORIGIN,
      getAccountAdmission,
    }
  );

  const desktopApi = createDesktopApi({
    // The transport edge: carry the channel to the registered main handler
    // exactly as Electron's `ipcRenderer.invoke` would.
    invoke: (channel: string, ...args: unknown[]) => {
      invokedChannels.push(channel);
      const handler = handlers.get(channel);
      if (!handler) {
        return Promise.reject(
          new Error(`no main handler registered for ${channel}`)
        );
      }
      return Promise.resolve(handler({ sender: TRUSTED_SENDER }, ...args));
    },
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
  });

  return { desktopApi, invokedChannels, requests };
}

test("the preload method reaches the API through the real channel and main handler", async () => {
  const { desktopApi, invokedChannels, requests } = createHop();

  const assignment = await desktopApi.getDesktopFeatureFlags();

  // The preload method must name THIS channel: aiming it at another one, or
  // deleting it, is exactly what the renderer-stubbing suite cannot catch.
  assert.deepEqual(invokedChannels, [DesktopFeatureFlagsIpcChannel.Get]);
  // The main client actually issued the authenticated request...
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${API_ORIGIN}/desktop/feature-flags`);
  assert.equal(
    (requests[0].init.headers as Record<string, string>).Authorization,
    `Bearer ${ACCESS_TOKEN}`
  );
  // ...and the envelope was unwrapped into the assignment the renderer reads.
  assert.deepEqual(assignment, ASSIGNMENT);
});

test("a failed API read arrives at the preload boundary as null, never as a partial assignment", async () => {
  const { desktopApi, invokedChannels } = createHop({
    body: "nope",
    status: 500,
  });

  // `null` is what the renderer reads as UNRESOLVED and therefore CLOSED. A
  // throw crossing this boundary instead would reject in the renderer's fetch
  // and take a different path than the one the gate was designed around.
  assert.equal(await desktopApi.getDesktopFeatureFlags(), null);
  assert.deepEqual(invokedChannels, [DesktopFeatureFlagsIpcChannel.Get]);
});

test("an untrusted sender is refused before the API is ever called", async () => {
  const { desktopApi, requests } = createHop({ isTrustedSender: () => false });

  assert.equal(await desktopApi.getDesktopFeatureFlags(), null);
  assert.deepEqual(requests, []);
});

const NODE_UUID = "44444444-4444-4444-8444-444444444444";
const ANONYMOUS_ASSIGNMENT = {
  userId: NODE_UUID,
  resolved: true,
  flags: { "desktop-session-replay": true },
};

// ISS-11945: with no admitted account the SAME preload method and channel take
// the unauthenticated mode, keyed by the install's node_uuid. The path, header
// and key are literals on purpose: installed builds and the PostHog flag hold
// these exact strings, so renaming a shared constant must turn this red.
test("a signed-out install reads the anonymous mode by node_uuid, with no credential", async () => {
  publishAnonymousDesktopFeatureFlagsSource({
    getApiOrigin: () => API_ORIGIN,
    getNodeUuid: () => NODE_UUID,
  });
  const { desktopApi, invokedChannels, requests } = createHop({
    body: JSON.stringify({ success: true, data: ANONYMOUS_ASSIGNMENT }),
    getAccountAdmission: () => null,
  });

  const assignment = await desktopApi.getDesktopFeatureFlags();

  assert.deepEqual(invokedChannels, [DesktopFeatureFlagsIpcChannel.Get]);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `${API_ORIGIN}/desktop/feature-flags/anonymous`
  );
  const headers = requests[0].init.headers as Record<string, string>;
  assert.equal(headers["x-desktop-node-uuid"], NODE_UUID);
  assert.equal("Authorization" in headers, false);
  assert.deepEqual(assignment, ANONYMOUS_ASSIGNMENT);
});

test("a signed-out read on a launch with no anonymous source (unpackaged) is null and never reaches the network", async () => {
  const { desktopApi, requests } = createHop({
    getAccountAdmission: () => null,
  });

  assert.equal(await desktopApi.getDesktopFeatureFlags(), null);
  assert.deepEqual(requests, []);
});

/**
 * ISS-8753 — the same claim for the E2E seam's preload method.
 *
 * The renderer suite that covers the seam installs a hand-written
 * `window.desktopApi`, so it cannot catch the preload method naming a channel no
 * main handler answers on. That failure mode is invisible in every other lane
 * and shows up only as silently-closed gates across `desktop-e2e`, so the
 * channel wiring is pinned here instead.
 *
 * The seam's own GATING — packaged refusal, launch argument, seed parsing — is
 * behavior of `readE2eFeatureFlagAssignment` and is covered in
 * `e2e-feature-flag-assignment.test.ts`; this asserts only that the two ends
 * meet.
 */
test("the E2E seam's preload method reaches its own channel, and serves null with no seed", async () => {
  const invokedChannels: string[] = [];
  const handlers = new Map<string, (event: unknown) => unknown>();

  registerE2eFeatureFlagSeedIpcHandler(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as (event: unknown) => unknown);
      },
    },
    {
      isTrustedSender: (sender) => sender === TRUSTED_SENDER,
      isPackaged: () => false,
      // A shipped launch: no harness argument, so the answer is a constant null
      // and the renderer falls through to the real assignment path.
      getArgv: () => ["electron", "."],
      getUserDataPath: () => "/nonexistent-profile",
    }
  );

  const desktopApi = createDesktopApi({
    invoke: (channel: string, ...args: unknown[]) => {
      invokedChannels.push(channel);
      const handler = handlers.get(channel);
      if (!handler) {
        return Promise.reject(
          new Error(`no main handler registered for ${channel}`)
        );
      }
      return Promise.resolve(handler({ sender: TRUSTED_SENDER, args }));
    },
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
  });

  assert.equal(await desktopApi.getE2eSeededFeatureFlags(), null);
  assert.deepEqual(invokedChannels, [DesktopFeatureFlagsIpcChannel.GetE2eSeed]);
});
