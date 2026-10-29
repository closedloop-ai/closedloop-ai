/**
 * ISS-12257 AC2, end to end below Electron: the real `DesktopSessionReplay`
 * records with the real posthog-js client, and every batch that leaves goes
 * through main's real `authorizeDesktopReplayRequest` and recording fence,
 * which stamp it with the identity main holds at that moment. Main's sign-in
 * state flips first and the renderer hears of it afterwards, as in the app.
 */
import { gunzipSync } from "node:zlib";
import { DESKTOP_SESSION_REPLAY_FLAG_KEY } from "@repo/api/src/types/desktop-feature-flags";
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  authorizeDesktopReplayRequest,
  createDesktopReplayRecordingFence,
} from "../../../main/auth/desktop-replay-request-auth";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../../shared/contracts";
import { DesktopFeatureFlagProvider } from "../../feature-flags/desktop-feature-flag-provider";
import { __resetRuntimeStatusPollForTests } from "../../hooks/use-runtime-status-poll";
import { DesktopAuthProvider } from "../../shared-agent-sessions/desktop-auth-provider";
import { DesktopSessionReplay } from "../desktop-session-replay";

// posthog-js binds `fetch` when it loads, so the stand-in for the network,
// with main's request hook in front of it, must be in place first.
const network = vi.hoisted(() => {
  const deliveries: { authorization: string | null; body: ArrayBuffer }[] = [];
  const refusals: ArrayBuffer[] = [];
  const hook: {
    beforeSendHeaders: (url: string) => Promise<Record<string, string> | null>;
  } = { beforeSendHeaders: () => Promise.resolve(null) };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = await new Response(init?.body).arrayBuffer();
    const headers = await hook.beforeSendHeaders(String(input));
    if (headers === null) {
      // How a request main cancels fails in the renderer.
      refusals.push(body);
      throw new TypeError("Failed to fetch");
    }
    deliveries.push({ authorization: headers.Authorization ?? null, body });
    return new Response('{"status":1}', { status: 200 });
  }) as typeof fetch;
  return { deliveries, refusals, hook, original };
});

// Literals, not the shared constants: these are the ISS-11946 contract.
const PROD_API_ORIGIN = "https://api.closedloop.ai";
const NODE_UUID = "2f1c8f8e-3b7a-4c1d-9e2f-5a6b7c8d9e0f";
const ACCESS_TOKEN = "desktop-access-token-under-test";
const SIGNED_IN = "signed in";
const SIGNED_OUT = "signed out";
const USER_ID = "user_desktop_1";
const AUTH_STATES = {
  [SIGNED_IN]: {
    status: DesktopAuthStatus.Authenticated,
    userId: USER_ID,
    organizationId: "org_1",
  },
  [SIGNED_OUT]: {
    status: DesktopAuthStatus.SignedOut,
    userId: null,
    organizationId: null,
  },
};
const IDENTITIES = { [SIGNED_IN]: USER_ID, [SIGNED_OUT]: NODE_UUID };
const batchSchema = z.array(
  z.object({ properties: z.object({ $session_id: z.string() }) })
);

let originalDesktopApiDescriptor: PropertyDescriptor | undefined;

afterEach(() => {
  cleanup();
  __resetRuntimeStatusPollForTests();
  if (originalDesktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", originalDesktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

afterAll(() => {
  globalThis.fetch = network.original;
});

describe("DesktopSessionReplay across a sign-in flip (ISS-12257)", () => {
  it.each([
    [SIGNED_OUT, SIGNED_IN],
    [SIGNED_IN, SIGNED_OUT],
  ] as const)(
    "never sends a batch recorded %s with the identity from after the flip to %s",
    async (before, after) => {
      const app = launch(before);
      const oldSession = await recordUntilDelivered(IDENTITIES[before]);

      // Main's token state changes first; the renderer has not heard yet.
      app.setMainSignedIn(after === SIGNED_IN);
      interact("between main's flip and the renderer's");
      await vi.waitFor(
        () => expect(sessionsIn(network.refusals)).toContain(oldSession),
        { timeout: 15_000, interval: 100 }
      );
      interact("in the tail the flip discards");
      act(() => app.pushAuthState(AUTH_STATES[after]));

      await vi.waitFor(() => expect(app.fence.isCurrent()).toBe(true), {
        timeout: 10_000,
      });
      const newSession = await recordUntilDelivered(IDENTITIES[after]);

      expect(newSession).not.toBe(oldSession);
      // posthog-js sends its queue in order, so a tail the flip flushed would
      // have left no later than the new session's first batch.
      expect(sessionsDeliveredAs(IDENTITIES[after])).not.toContain(oldSession);
      expect(sessionsDeliveredAs(IDENTITIES[before])).not.toContain(newSession);
    },
    60_000
  );
});

/** Main's sign-in state and request hook, and the renderer's bridge to it. */
function launch(signedIn: typeof SIGNED_IN | typeof SIGNED_OUT) {
  const main = { signedIn: signedIn === SIGNED_IN, authGeneration: 0 };
  const fence = createDesktopReplayRecordingFence(
    () => main.signedIn,
    () => main.authGeneration
  );
  network.hook.beforeSendHeaders = (url) =>
    authorizeDesktopReplayRequest(
      { url, method: "POST", requestHeaders: {} },
      {
        getAccessToken: () =>
          Promise.resolve(main.signedIn ? ACCESS_TOKEN : null),
        resolveApiOrigin: () => PROD_API_ORIGIN,
        isRecordingSignInCurrent: fence.isCurrent,
      }
    );

  let authState: DesktopAuthState = {
    ...AUTH_STATES[signedIn],
    authGeneration: main.authGeneration,
  };
  const authListeners: Array<(next: unknown) => void> = [];
  originalDesktopApiDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "desktopApi"
  );
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: () => Promise.resolve(authState),
      onDesktopAuthStateChanged: (onChange: (next: unknown) => void) => {
        authListeners.push(onChange);
        return () => {
          authListeners.splice(authListeners.indexOf(onChange), 1);
        };
      },
      // The gate is open for the install and for the user alike.
      getDesktopFeatureFlags: () =>
        Promise.resolve({
          userId: authState.userId ?? NODE_UUID,
          resolved: true,
          flags: { [DESKTOP_SESSION_REPLAY_FLAG_KEY]: true },
        }),
      getRuntimeStatus: () =>
        Promise.resolve({
          isPackaged: true,
          apiOrigin: PROD_API_ORIGIN,
          nodeUuid: NODE_UUID,
        }),
      // The IPC hop is `test/desktop-session-replay-preload-hop.test.ts`'s.
      reportDesktopReplayRecording: (recording: unknown) => {
        fence.report(recording);
        return Promise.resolve(true);
      },
    },
  });

  render(
    <DesktopAuthProvider>
      <DesktopFeatureFlagProvider>
        <DesktopSessionReplay />
      </DesktopFeatureFlagProvider>
    </DesktopAuthProvider>
  );

  return {
    fence,
    setMainSignedIn(next: boolean) {
      main.signedIn = next;
      main.authGeneration += 1;
    },
    pushAuthState(next: (typeof AUTH_STATES)[keyof typeof AUTH_STATES]) {
      authState = { ...next, authGeneration: main.authGeneration };
      for (const listener of [...authListeners]) {
        listener(authState);
      }
    },
  };
}

/**
 * Interacts until a batch of a new session is delivered as `identity`; returns
 * that session. Vitest's wait, not Testing Library's `waitFor`, which re-runs
 * on every DOM change and so never settles on a callback that changes the DOM.
 */
async function recordUntilDelivered(identity: string): Promise<string> {
  const known = new Set(sessionsIn(network.deliveries.map(({ body }) => body)));
  return await vi.waitUntil(
    () => {
      interact("recording");
      return sessionsDeliveredAs(identity).find(
        (session) => !known.has(session)
      );
    },
    { timeout: 20_000, interval: 250 }
  );
}

/** A DOM change and a click, so the recording has something new to buffer. */
function interact(label: string): void {
  const node = document.createElement("p");
  node.textContent = label;
  document.body.append(node);
  node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function sessionsDeliveredAs(identity: string): string[] {
  return sessionsIn(
    network.deliveries
      .filter(
        ({ authorization }) =>
          (authorization === null ? NODE_UUID : USER_ID) === identity
      )
      .map(({ body }) => body)
  );
}

function sessionsIn(bodies: ArrayBuffer[]): string[] {
  return bodies.flatMap((body) =>
    batchSchema
      .parse(JSON.parse(gunzipSync(Buffer.from(body)).toString("utf8")))
      .map(({ properties }) => properties.$session_id)
  );
}
