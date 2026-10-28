import assert from "node:assert/strict";
import { log } from "@repo/observability/log";
import { ChannelKind } from "@repo/realtime-contract/channels";
import { RealtimeInternalPath } from "@repo/realtime-contract/internal";
import { getVercelOidcToken } from "@vercel/oidc";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { z } from "zod";
import type { SignalTypeRegistry } from "../emit-signal";
import {
  createRealtimeServerClient,
  parseRealtimeInternalConfig,
  REALTIME_INTERNAL_CALL_FAILED_EVENT,
  REALTIME_INTERNAL_NOT_CONFIGURED_EVENT,
  RealtimeCallFailure,
  type RealtimeInternalConfig,
} from "../internal-client";

vi.mock("@vercel/oidc", () => ({ getVercelOidcToken: vi.fn() }));

const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CHANNEL = `${ChannelKind.Comments}:${ORG_ID}:thread-1`;
const FIXTURE_TYPE = "fixture.changed";
const FIXTURE_REGISTRY: SignalTypeRegistry = {
  [ChannelKind.Comments]: {
    [FIXTURE_TYPE]: z.object({ id: z.string(), revision: z.number().int() }),
  },
};
const OIDC_AUDIENCE = "realtime-internal-fixture";
const OIDC_TOKEN = "header.payload-for-the-realtime-audience.signature";
const CONFIG: RealtimeInternalConfig = {
  url: "http://realtime.internal:3040",
  oidcAudience: OIDC_AUDIENCE,
};
const SIGNAL = { type: FIXTURE_TYPE, data: { id: "c1", revision: 2 } };
/** AbortSignal.timeout runs on Node's own timers, which fake timers do not reach. */
const STALL_TIMEOUT_MS = 20;
/** A fetch that is never aborted hangs until this fails the test. */
const STALL_TEST_TIMEOUT_MS = 5000;

function acceptingFetch(status = 202) {
  return vi.fn((_url: URL | RequestInfo, _init?: RequestInit) =>
    Promise.resolve(new Response(null, { status }))
  );
}

beforeEach(() => {
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  vi.mocked(getVercelOidcToken).mockReset().mockResolvedValue(OIDC_TOKEN);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publish", () => {
  it("posts the validated signal to /internal/publish with the OIDC bearer", async () => {
    const fetch = acceptingFetch();
    const client = createRealtimeServerClient({ config: CONFIG, fetch });

    const result = await client.publish(CHANNEL, SIGNAL, FIXTURE_REGISTRY);

    assert.deepEqual(result, { ok: true });
    assert.equal(fetch.mock.calls.length, 1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    assert.equal(String(url), `${CONFIG.url}${RealtimeInternalPath.Publish}`);
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, {
      "content-type": "application/json",
      authorization: `Bearer ${OIDC_TOKEN}`,
    });
    assert.deepEqual(JSON.parse(String(init?.body)), {
      channel: CHANNEL,
      ...SIGNAL,
    });
  });

  it("resolves unreachable on a network failure, without throwing, and logs it", async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const client = createRealtimeServerClient({ config: CONFIG, fetch });

    const result = await client.publish(CHANNEL, SIGNAL, FIXTURE_REGISTRY);

    assert.deepEqual(result, {
      ok: false,
      failure: RealtimeCallFailure.Unreachable,
    });
    assert.equal(fetch.mock.calls.length, 1);
    assert.deepEqual(vi.mocked(log.error).mock.calls[0]?.[1], {
      event: REALTIME_INTERNAL_CALL_FAILED_EVENT,
      path: RealtimeInternalPath.Publish,
      failure: RealtimeCallFailure.Unreachable,
      httpStatus: undefined,
      cause: "TypeError",
    });
  });

  it("resolves rejected with the status when the service answers anything but 202", async () => {
    const client = createRealtimeServerClient({
      config: CONFIG,
      fetch: acceptingFetch(401),
    });

    const result = await client.publish(CHANNEL, SIGNAL, FIXTURE_REGISTRY);

    assert.deepEqual(result, {
      ok: false,
      failure: RealtimeCallFailure.Rejected,
      status: 401,
    });
    assert.deepEqual(vi.mocked(log.error).mock.calls[0]?.[1], {
      event: REALTIME_INTERNAL_CALL_FAILED_EVENT,
      path: RealtimeInternalPath.Publish,
      failure: RealtimeCallFailure.Rejected,
      httpStatus: 401,
      cause: undefined,
    });
  });

  it.each([
    ["an undeclared type", CHANNEL, { type: "fixture.undeclared", data: {} }],
    [
      "data that fails the type's schema",
      CHANNEL,
      { type: FIXTURE_TYPE, data: { id: "c1", revision: "2" } },
    ],
    ["a malformed address", `${ChannelKind.Comments}:not-an-org:x`, SIGNAL],
    [
      "data past the signal byte cap",
      CHANNEL,
      { type: FIXTURE_TYPE, data: { id: "x".repeat(2048), revision: 1 } },
    ],
  ])("refuses %s without a request", async (_name, channel, signal) => {
    const fetch = acceptingFetch();
    const client = createRealtimeServerClient({ config: CONFIG, fetch });

    const result = await client.publish(channel, signal, FIXTURE_REGISTRY);

    assert.deepEqual(result, {
      ok: false,
      failure: RealtimeCallFailure.Invalid,
    });
    assert.equal(fetch.mock.calls.length, 0);
  });

  it("checks the default registry, which declares no fixture type", async () => {
    const fetch = acceptingFetch();
    const client = createRealtimeServerClient({ config: CONFIG, fetch });

    const result = await client.publish(CHANNEL, SIGNAL);

    assert.deepEqual(result, {
      ok: false,
      failure: RealtimeCallFailure.Invalid,
    });
    assert.equal(fetch.mock.calls.length, 0);
  });
});

describe("revoke", () => {
  it("posts the target to /internal/revoke", async () => {
    const fetch = acceptingFetch();
    const client = createRealtimeServerClient({ config: CONFIG, fetch });

    const result = await client.revoke({ orgId: ORG_ID });

    assert.deepEqual(result, { ok: true });
    const [url, init] = fetch.mock.calls[0] ?? [];
    assert.equal(String(url), `${CONFIG.url}${RealtimeInternalPath.Revoke}`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      target: { orgId: ORG_ID },
    });
  });

  it("refuses a malformed target without a request", async () => {
    const fetch = acceptingFetch();
    const client = createRealtimeServerClient({ config: CONFIG, fetch });

    const result = await client.revoke({ orgId: "not-an-org" });

    assert.deepEqual(result, {
      ok: false,
      failure: RealtimeCallFailure.Invalid,
    });
    assert.equal(fetch.mock.calls.length, 0);
  });
});

describe("a stalled service", () => {
  it(
    "aborts the request at the call timeout, and publish and revoke both resolve unreachable",
    async () => {
      const fetch = vi.fn(
        (_url: URL | RequestInfo, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason)
            );
          })
      );
      const client = createRealtimeServerClient({
        config: CONFIG,
        fetch,
        timeoutMs: STALL_TIMEOUT_MS,
      });

      const [published, revoked] = await Promise.all([
        client.publish(CHANNEL, SIGNAL, FIXTURE_REGISTRY),
        client.revoke({ orgId: ORG_ID }),
      ]);

      const unreachable = {
        ok: false,
        failure: RealtimeCallFailure.Unreachable,
      };
      assert.deepEqual(published, unreachable);
      assert.deepEqual(revoked, unreachable);
      assert.equal(fetch.mock.calls.length, 2);
    },
    STALL_TEST_TIMEOUT_MS
  );
});

describe("an unconfigured client", () => {
  it("sends nothing and logs that once", async () => {
    const fetch = acceptingFetch();
    const client = createRealtimeServerClient({ config: undefined, fetch });

    const published = await client.publish(CHANNEL, SIGNAL, FIXTURE_REGISTRY);
    const revoked = await client.revoke({ orgId: ORG_ID });

    assert.deepEqual(published, {
      ok: false,
      failure: RealtimeCallFailure.NotConfigured,
    });
    assert.deepEqual(revoked, published);
    assert.equal(fetch.mock.calls.length, 0);
    assert.deepEqual(
      vi.mocked(log.warn).mock.calls.map(([, fields]) => fields),
      [{ event: REALTIME_INTERNAL_NOT_CONFIGURED_EVENT }]
    );
  });
});

describe("parseRealtimeInternalConfig", () => {
  it("takes the URL and the OIDC audience", () => {
    assert.deepEqual(
      parseRealtimeInternalConfig({
        internalUrl: CONFIG.url,
        oidcAudience: OIDC_AUDIENCE,
      }),
      CONFIG
    );
  });

  it.each([
    [undefined, OIDC_AUDIENCE],
    ["not a url", OIDC_AUDIENCE],
    [CONFIG.url, undefined],
    [CONFIG.url, " "],
    [CONFIG.url, "https://vercel.com/fixture-team"],
  ])("is unset for url %j and audience %j", (internalUrl, oidcAudience) => {
    assert.equal(
      parseRealtimeInternalConfig({ internalUrl, oidcAudience }),
      undefined
    );
  });
});

describe("a base URL with a path", () => {
  it.each([
    "http://realtime.internal:3040/rt",
    "http://realtime.internal:3040/rt/",
  ])("keeps the path in front of the internal path for %j", async (base) => {
    const fetch = acceptingFetch();
    const client = createRealtimeServerClient({
      config: { ...CONFIG, url: base },
      fetch,
    });

    await client.revoke({ orgId: ORG_ID });

    const [url] = fetch.mock.calls[0] ?? [];
    assert.equal(
      String(url),
      `http://realtime.internal:3040/rt${RealtimeInternalPath.Revoke}`
    );
  });
});

describe("the Vercel OIDC bearer (ISS-11966)", () => {
  it("sends the token minted for the configured audience, and no shared-secret header", async () => {
    const fetch = acceptingFetch();
    const client = createRealtimeServerClient({ config: CONFIG, fetch });

    assert.deepEqual(await client.revoke({ orgId: ORG_ID }), { ok: true });

    assert.deepEqual(vi.mocked(getVercelOidcToken).mock.calls, [
      [{ audience: OIDC_AUDIENCE }],
    ]);
    assert.deepEqual(fetch.mock.calls[0]?.[1]?.headers, {
      "content-type": "application/json",
      authorization: `Bearer ${OIDC_TOKEN}`,
    });
  });

  it(
    "gives a stalled token exchange no more than the call's timeout",
    async () => {
      vi.mocked(getVercelOidcToken).mockReturnValue(
        new Promise(() => undefined)
      );
      const fetch = acceptingFetch();
      const client = createRealtimeServerClient({
        config: CONFIG,
        fetch,
        timeoutMs: STALL_TIMEOUT_MS,
      });

      const result = await client.revoke({ orgId: ORG_ID });

      assert.deepEqual(result, {
        ok: false,
        failure: RealtimeCallFailure.TokenUnavailable,
      });
      assert.equal(fetch.mock.calls.length, 0);
    },
    STALL_TEST_TIMEOUT_MS
  );

  it("resolves token_unavailable with no request when the token cannot be fetched", async () => {
    vi.mocked(getVercelOidcToken).mockRejectedValue(
      new Error(`refresh failed for ${OIDC_TOKEN}`)
    );
    const fetch = acceptingFetch();
    const client = createRealtimeServerClient({
      config: CONFIG,
      fetch,
    });

    const result = await client.revoke({ orgId: ORG_ID });

    assert.deepEqual(result, {
      ok: false,
      failure: RealtimeCallFailure.TokenUnavailable,
    });
    assert.equal(fetch.mock.calls.length, 0);
    assert.deepEqual(vi.mocked(log.error).mock.calls[0]?.[1], {
      event: REALTIME_INTERNAL_CALL_FAILED_EVENT,
      path: RealtimeInternalPath.Revoke,
      failure: RealtimeCallFailure.TokenUnavailable,
      httpStatus: undefined,
      cause: "Error",
    });
  });

  it("never hands the token to the logger", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(log, "debug").mockImplementation(() => undefined);
    const client = createRealtimeServerClient({
      config: CONFIG,
      fetch: acceptingFetch(401),
    });

    await client.publish(CHANNEL, SIGNAL, FIXTURE_REGISTRY);
    vi.mocked(getVercelOidcToken).mockRejectedValue(new Error(OIDC_TOKEN));
    await client.publish(CHANNEL, SIGNAL, FIXTURE_REGISTRY);

    assert.equal(vi.mocked(log.error).mock.calls.length, 2);
    const logged = JSON.stringify(
      [log.error, log.warn, info, debug].flatMap(
        (spy) => vi.mocked(spy).mock.calls
      )
    );
    assert.equal(logged.includes(OIDC_TOKEN), false);
  });
});
