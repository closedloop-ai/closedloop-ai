import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchDesktopIdentity } from "../src/main/desktop-identity-client.js";
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
