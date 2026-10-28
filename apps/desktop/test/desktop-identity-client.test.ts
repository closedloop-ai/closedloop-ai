import assert from "node:assert/strict";
import { test } from "vitest";
import { fetchDesktopIdentity } from "../src/main/auth/desktop-identity-client.js";
import { sessionFetchStub } from "./session-fetch-test-utils.js";

const API_ORIGIN = "https://api.closedloop.test";
const IDENTITY = {
  userId: "user-1",
  organizationId: "org-1",
  email: "kerensa@closedloop.ai",
  firstName: "Kerensa",
  lastName: "Whitlock",
  organizationName: "Acme Inc",
};

const options = (overrides: {
  fetch: typeof fetch;
  token?: string | null;
  origin?: string;
}) => ({
  fetch: overrides.fetch,
  getAccessToken: () =>
    Promise.resolve<string | null>(
      "token" in overrides ? (overrides.token ?? null) : "access-token"
    ),
  getApiOrigin: () => overrides.origin ?? API_ORIGIN,
});

test("fetchDesktopIdentity unwraps the success envelope and Bearer-auths", async () => {
  const { fetchImpl, calls } = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: IDENTITY }), {
      status: 200,
    })
  );

  const result = await fetchDesktopIdentity(options({ fetch: fetchImpl }));

  assert.deepEqual(result, IDENTITY);
  assert.equal(calls[0].url, `${API_ORIGIN}/desktop/identity`);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer access-token");
});

test("fetchDesktopIdentity returns null without an access token", async () => {
  const { fetchImpl, calls } = sessionFetchStub(
    new Response("{}", { status: 200 })
  );

  const result = await fetchDesktopIdentity(
    options({ fetch: fetchImpl, token: null })
  );

  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test("fetchDesktopIdentity returns null on a non-2xx response", async () => {
  const { fetchImpl } = sessionFetchStub(new Response("nope", { status: 401 }));

  const result = await fetchDesktopIdentity(options({ fetch: fetchImpl }));

  assert.equal(result, null);
});

test("fetchDesktopIdentity returns null on a schema-invalid body", async () => {
  const { fetchImpl } = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: { userId: 1 } }), {
      status: 200,
    })
  );

  const result = await fetchDesktopIdentity(options({ fetch: fetchImpl }));

  assert.equal(result, null);
});

test("fetchDesktopIdentity: a truncated body missing a REQUIRED field fails closed to null (not degrade)", async () => {
  // `organizationId` dropped: a malformed current-server response, indistinguishable
  // from an old server by field-presence alone if it reached the store — but the
  // schema rejects it first, so it never degrades to allow.
  const { organizationId: _dropped, ...truncated } = IDENTITY;
  const { fetchImpl } = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: truncated }), {
      status: 200,
    })
  );

  const result = await fetchDesktopIdentity(options({ fetch: fetchImpl }));

  assert.equal(result, null);
});

test("ISS-11449: a server still sending the retired policy fields parses, and they are ignored", async () => {
  // Servers keep sending `sessionSyncPolicyEnabled` and
  // `sessionSyncPolicySupported` for desktops built before ISS-11449, and this
  // schema no longer declares either. What
  // this pins is that an UNDECLARED key does not fail the parse: a rejection
  // would return `null` and blank the Account tab against a healthy server. It
  // does NOT pin `.passthrough()` specifically — a bare `z.object` strips unknown
  // keys and would pass this too; the case guards against someone tightening the
  // schema to `.strict()`, which is the shape that would reject.
  const legacyServerIdentity = {
    ...IDENTITY,
    sessionSyncPolicyEnabled: false,
    sessionSyncPolicySupported: true,
  };
  const { fetchImpl } = sessionFetchStub(
    new Response(
      JSON.stringify({ success: true, data: legacyServerIdentity }),
      {
        status: 200,
      }
    )
  );

  const result = await fetchDesktopIdentity(options({ fetch: fetchImpl }));

  assert.ok(result);
  // Every declared field survives, which is the half that matters. The retired
  // keys ride through untyped (that part IS `.passthrough()`), and no consumer
  // reads them.
  assert.equal(result.userId, IDENTITY.userId);
  assert.equal(result.organizationId, IDENTITY.organizationId);
  assert.equal(result.organizationName, IDENTITY.organizationName);
});

test("fetchDesktopIdentity refuses a non-string image field instead of passing it through", async () => {
  // ISS-11465: `.passthrough()` carries an UNDECLARED key through untouched, so
  // before these two were declared on the schema a number or an object landed
  // in the renderer typed `string | undefined` and went straight into an
  // `<img src>`. The well-formed case below is the presence half on the same
  // field, so this cannot pass by rejecting everything.
  const { fetchImpl } = sessionFetchStub(
    new Response(
      JSON.stringify({
        success: true,
        data: { ...IDENTITY, organizationImageUrl: 42 },
      }),
      { status: 200 }
    )
  );

  const result = await fetchDesktopIdentity(options({ fetch: fetchImpl }));

  assert.equal(result, null);
});

test("fetchDesktopIdentity accepts the images present, null, and absent", async () => {
  const withImages = sessionFetchStub(
    new Response(
      JSON.stringify({
        success: true,
        data: {
          ...IDENTITY,
          organizationImageUrl: "https://img.clerk.com/org",
          userImageUrl: null,
        },
      }),
      { status: 200 }
    )
  );

  const result = await fetchDesktopIdentity(
    options({ fetch: withImages.fetchImpl })
  );

  assert.equal(result?.organizationImageUrl, "https://img.clerk.com/org");
  assert.equal(result?.userImageUrl, null);

  // An OLDER server omits both entirely; that is not a payload rejection.
  const withoutImages = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: IDENTITY }), {
      status: 200,
    })
  );

  const older = await fetchDesktopIdentity(
    options({ fetch: withoutImages.fetchImpl })
  );

  assert.equal(older?.organizationImageUrl, undefined);
  assert.equal(older?.userImageUrl, undefined);
});
