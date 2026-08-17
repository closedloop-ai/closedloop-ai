import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchDesktopIdentity } from "../src/main/auth/desktop-identity-client.js";
import { sessionFetchStub } from "./session-fetch-test-utils.js";

const API_ORIGIN = "https://api.closedloop.test";
const IDENTITY = {
  userId: "user-1",
  organizationId: "org-1",
  email: "kris@closedloop.ai",
  firstName: "Kris",
  lastName: "Wong",
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

// ISS-4623 (shafty023 review) — the ONLY response that reaches the store's
// `"unsupported"` (degrade-to-allow) arm must be an otherwise well-formed
// identity that omits ONLY the optional `sessionSyncPolicyEnabled` AND carries no
// capability marker. A malformed or truncated CURRENT-server response that drops
// a REQUIRED field must fail the schema and return `null`, so the store keeps its
// fail-closed last-known state rather than mistaking the truncation for an old
// server and degrading to allow.
test("fetchDesktopIdentity: well-formed body omitting ONLY the policy field parses (feeds the 'unsupported' degrade)", async () => {
  const { fetchImpl } = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: IDENTITY }), {
      status: 200,
    })
  );

  const result = await fetchDesktopIdentity(options({ fetch: fetchImpl }));

  // IDENTITY has every required field but no `sessionSyncPolicyEnabled`.
  assert.notEqual(result, null);
  assert.equal(result?.sessionSyncPolicyEnabled, undefined);
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

test("fetchDesktopIdentity preserves the ISS-4705 capability marker + policy flag", async () => {
  const capableIdentity = {
    ...IDENTITY,
    sessionSyncPolicyEnabled: false,
    sessionSyncPolicySupported: true,
  };
  const { fetchImpl } = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: capableIdentity }), {
      status: 200,
    })
  );

  const result = await fetchDesktopIdentity(options({ fetch: fetchImpl }));

  assert.deepEqual(result, capableIdentity);
});

test("fetchDesktopIdentity parses a buggy CURRENT-server body: marker present, policy field dropped", async () => {
  // ISS-4705 sub-case 2: an otherwise well-formed identity that advertises
  // policy support but omits ONLY sessionSyncPolicyEnabled is still a VALID
  // response shape (the field is optional). The schema must not reject it — the
  // fail-closed decision belongs to the policy store, which reads the marker.
  const buggyCurrentIdentity = {
    ...IDENTITY,
    sessionSyncPolicySupported: true,
  };
  const { fetchImpl } = sessionFetchStub(
    new Response(
      JSON.stringify({ success: true, data: buggyCurrentIdentity }),
      {
        status: 200,
      }
    )
  );

  const result = await fetchDesktopIdentity(options({ fetch: fetchImpl }));

  // The dropped field must be ABSENT, not present-and-undefined. `Object.hasOwn`
  // says so directly; reading `result.sessionSyncPolicyEnabled` after the
  // deepEqual below cannot, because that assertion narrows `result` to the
  // fixture's own type — which has no such key, making the check vacuous.
  assert.ok(result);
  assert.equal(Object.hasOwn(result, "sessionSyncPolicyEnabled"), false);
  assert.deepEqual(result, buggyCurrentIdentity);
  assert.equal(result.sessionSyncPolicySupported, true);
});
