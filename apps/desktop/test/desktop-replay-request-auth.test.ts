/**
 * ISS-12222: main attaches the desktop access token to the renderer's replay
 * snapshot requests, and only to those, so the replay ingress can stamp a
 * signed-in install's replays with its user while the renderer holds no
 * credential.
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import {
  authorizeDesktopReplayRequest,
  DESKTOP_REPLAY_REQUEST_URL_PATTERNS,
  type DesktopReplayRequest,
  installDesktopReplayRequestAuth,
} from "../src/main/auth/desktop-replay-request-auth.js";
import {
  ACCESS_TTL_MS,
  createManager,
  createStubClient,
  installTempRoot,
  makeTokens,
  storedRecord,
  T0,
} from "./helpers/desktop-session-manager-fixtures.js";

// Literals, not the shared constants: the hosts and the path posthog-js posts
// to are the contract under test.
const PROD_API_ORIGIN = "https://api.closedloop.ai";
const STAGE_API_ORIGIN = "https://api.stage.example";
const SNAPSHOT_URL = `${PROD_API_ORIGIN}/r/s?compression=gzip-js&ip=0&_=1759838400000&ver=1.372.6`;
const ACCESS_TOKEN = "desktop-access-token-under-test";
const RENDERER_HEADERS = { "Content-Type": "text/plain" };

installTempRoot();

function deps(
  options: { accessToken?: string | null; apiOrigin?: string } = {}
) {
  return {
    getAccessToken: vi.fn(() =>
      Promise.resolve(
        options.accessToken === undefined ? ACCESS_TOKEN : options.accessToken
      )
    ),
    resolveApiOrigin: () => options.apiOrigin ?? PROD_API_ORIGIN,
    isRecordingSignInCurrent: () => true,
  };
}

function snapshotPost(
  overrides: Partial<DesktopReplayRequest> = {}
): DesktopReplayRequest {
  return {
    url: SNAPSHOT_URL,
    method: "POST",
    requestHeaders: RENDERER_HEADERS,
    ...overrides,
  };
}

describe("authorizeDesktopReplayRequest", () => {
  it("adds the access token to a signed-in install's snapshot POST", async () => {
    const headers = await authorizeDesktopReplayRequest(snapshotPost(), deps());

    assert.deepEqual(headers, {
      ...RENDERER_HEADERS,
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    });
  });

  it("leaves a signed-out install's request untouched", async () => {
    const headers = await authorizeDesktopReplayRequest(
      snapshotPost(),
      deps({ accessToken: null })
    );

    assert.deepEqual(headers, RENDERER_HEADERS);
  });

  it.each([
    ["a preflight", snapshotPost({ method: "OPTIONS" })],
    ["another path", snapshotPost({ url: `${PROD_API_ORIGIN}/r/sx` })],
    ["a nested path", snapshotPost({ url: `${PROD_API_ORIGIN}/r/s/extra` })],
    [
      "the other replay origin",
      snapshotPost({ url: `${STAGE_API_ORIGIN}/r/s?compression=gzip-js` }),
    ],
  ])("sends no token on %s", async (_label, request) => {
    const requestDeps = deps();

    const headers = await authorizeDesktopReplayRequest(request, requestDeps);

    assert.deepEqual(headers, RENDERER_HEADERS);
    assert.equal(requestDeps.getAccessToken.mock.calls.length, 0);
  });

  it("sends a stage install's token to the stage origin", async () => {
    const requestDeps = deps({ apiOrigin: STAGE_API_ORIGIN });

    const headers = await authorizeDesktopReplayRequest(
      snapshotPost({ url: `${STAGE_API_ORIGIN}/r/s?compression=gzip-js` }),
      requestDeps
    );

    assert.equal(headers?.Authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.deepEqual(requestDeps.getAccessToken.mock.calls, [
      [STAGE_API_ORIGIN],
    ]);
  });

  // whitlockk on #8564: applying another API profile keeps the session and its
  // cached token, so the token must be bound to the origin that minted it.
  it("sends the cached stage token nowhere after a stage-to-prod profile switch, and prod's own token once prod mints one", async () => {
    let apiOrigin = STAGE_API_ORIGIN;
    let nowMs = T0;
    const stub = createStubClient();
    stub.setRefresh({
      ok: true,
      value: makeTokens({ accessToken: "stage-access" }),
    });
    const { manager, store } = createManager({
      stub,
      now: () => nowMs,
      storeName: "replay-profile-switch",
      resolveApiOrigin: () => apiOrigin,
    });
    store.setSession(storedRecord());
    await manager.restore();
    const managerDeps = {
      getAccessToken: (origin: string) =>
        manager.getAccessTokenIssuedBy(origin),
      resolveApiOrigin: () => apiOrigin,
      isRecordingSignInCurrent: () => true,
    };
    const stageHeaders = await authorizeDesktopReplayRequest(
      snapshotPost({ url: `${STAGE_API_ORIGIN}/r/s?compression=gzip-js` }),
      managerDeps
    );
    assert.equal(stageHeaders?.Authorization, "Bearer stage-access");

    apiOrigin = PROD_API_ORIGIN;
    const switchedHeaders = await authorizeDesktopReplayRequest(
      snapshotPost(),
      managerDeps
    );

    assert.deepEqual(switchedHeaders, RENDERER_HEADERS);
    assert.equal(stub.calls.refresh, 1, "the stage token was still cached");

    nowMs = T0 + ACCESS_TTL_MS;
    stub.setRefresh({
      ok: true,
      value: makeTokens({ accessToken: "prod-access" }),
    });
    const refreshedHeaders = await authorizeDesktopReplayRequest(
      snapshotPost(),
      managerDeps
    );
    assert.equal(refreshedHeaders?.Authorization, "Bearer prod-access");
  });

  it("replaces an authorization header the renderer set", async () => {
    const headers = await authorizeDesktopReplayRequest(
      snapshotPost({
        requestHeaders: { ...RENDERER_HEADERS, authorization: "Bearer forged" },
      }),
      deps()
    );

    assert.deepEqual(headers, {
      ...RENDERER_HEADERS,
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    });
  });
});

describe("installDesktopReplayRequestAuth", () => {
  it("listens on the replay snapshot path of every replay origin", () => {
    const { session, filters } = fakeSession();

    installDesktopReplayRequestAuth({ ...deps(), session: session as never });

    assert.deepEqual(filters, [
      { urls: [`${PROD_API_ORIGIN}/r/s*`, `${STAGE_API_ORIGIN}/r/s*`] },
    ]);
    assert.deepEqual(DESKTOP_REPLAY_REQUEST_URL_PATTERNS, filters[0].urls);
  });

  it("lets the request leave with the token", async () => {
    const { session, send } = fakeSession();
    installDesktopReplayRequestAuth({ ...deps(), session: session as never });

    const response = await send(snapshotPost());

    assert.deepEqual(response, {
      requestHeaders: {
        ...RENDERER_HEADERS,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });
  });

  it("lets the request leave untouched when the token cannot be read", async () => {
    const { session, send } = fakeSession();
    installDesktopReplayRequestAuth({
      getAccessToken: () => Promise.reject(new Error("refresh failed")),
      resolveApiOrigin: () => PROD_API_ORIGIN,
      isRecordingSignInCurrent: () => true,
      session: session as never,
    });

    const response = await send(snapshotPost());

    assert.deepEqual(response, { requestHeaders: RENDERER_HEADERS });
  });

  // ISS-12257: a batch recorded under the other sign-in state never leaves.
  it("cancels a snapshot POST recorded under the other sign-in state", async () => {
    const { session, send } = fakeSession();
    installDesktopReplayRequestAuth({
      ...deps(),
      isRecordingSignInCurrent: () => false,
      session: session as never,
    });

    const response = await send(snapshotPost());

    assert.deepEqual(response, { cancel: true });
  });

  it("cancels it when the token read fails after the sign-in state flipped", async () => {
    let current = true;
    const { session, send } = fakeSession();
    installDesktopReplayRequestAuth({
      getAccessToken: () => {
        current = false;
        return Promise.reject(new Error("refresh failed"));
      },
      resolveApiOrigin: () => PROD_API_ORIGIN,
      isRecordingSignInCurrent: () => current,
      session: session as never,
    });

    const response = await send(snapshotPost());

    assert.deepEqual(response, { cancel: true });
  });
});

type BeforeSendHeadersResponse = {
  cancel?: boolean;
  requestHeaders?: Record<string, string>;
};

type BeforeSendHeadersListener = (
  details: DesktopReplayRequest,
  callback: (response: BeforeSendHeadersResponse) => void
) => void;

function fakeSession() {
  const filters: { urls: string[] }[] = [];
  let listener: BeforeSendHeadersListener | undefined;
  const session = {
    webRequest: {
      onBeforeSendHeaders(
        filter: { urls: string[] },
        next: BeforeSendHeadersListener
      ) {
        filters.push(filter);
        listener = next;
      },
    },
  };
  const send = (details: DesktopReplayRequest) =>
    new Promise<BeforeSendHeadersResponse>((resolve) => {
      if (!listener) {
        throw new Error("no onBeforeSendHeaders listener was installed");
      }
      listener(details, resolve);
    });
  return { session, filters, send };
}
