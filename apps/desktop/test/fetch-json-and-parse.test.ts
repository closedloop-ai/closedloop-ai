import assert from "node:assert/strict";
import { DesktopClientAttributionHeader } from "@repo/api/src/types/desktop-client-attribution";
import { test } from "vitest";
import { z } from "zod";
import { unwrapApiEnvelope } from "../src/main/util/api-response-utils.js";
import {
  resetDesktopClientAttribution,
  setDesktopClientAttributionResolver,
} from "../src/main/util/desktop-client-attribution-provider.js";
import { fetchJsonAndParse } from "../src/main/util/fetch-json-and-parse.js";

const API_ORIGIN = "https://api.closedloop.test";
const schema = z.object({ value: z.string() }).passthrough();

type FetchCall = {
  url: string;
  init: RequestInit;
};

function fetchStub(response: Response | "throw"): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response === "throw") {
      return Promise.reject(new Error("network down"));
    }
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const baseOptions = (fetchImpl: typeof fetch) => ({
  apiOrigin: API_ORIGIN,
  token: "access-token",
  unwrap: unwrapApiEnvelope,
  sentinel: null,
  fetchImpl,
});

test("fetchJsonAndParse unwraps the envelope, GETs, and Bearer-auths", async () => {
  const { fetchImpl, calls } = fetchStub(
    new Response(JSON.stringify({ success: true, data: { value: "ok" } }), {
      status: 200,
    })
  );

  const result = await fetchJsonAndParse("/thing", schema, {
    ...baseOptions(fetchImpl),
    headers: { Accept: "application/json" },
    timeoutMs: 10_000,
  });

  assert.deepEqual(result, { value: "ok" });
  assert.equal(calls[0]?.url, `${API_ORIGIN}/thing`);
  assert.equal(calls[0]?.init.method, "GET");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer access-token");
  assert.equal(headers.Accept, "application/json");
  assert.ok(
    calls[0]?.init.signal instanceof AbortSignal,
    "a timeoutMs must attach an abort signal"
  );
});

test("fetchJsonAndParse omits the abort signal when no timeout is given", async () => {
  const { fetchImpl, calls } = fetchStub(
    new Response(JSON.stringify({ success: true, data: { value: "ok" } }), {
      status: 200,
    })
  );

  await fetchJsonAndParse("/thing", schema, baseOptions(fetchImpl));

  assert.equal(calls[0]?.init.signal ?? null, null);
});

test("fetchJsonAndParse returns the sentinel on a malformed URL", async () => {
  const { fetchImpl, calls } = fetchStub(new Response("{}", { status: 200 }));

  const result = await fetchJsonAndParse("/thing", schema, {
    ...baseOptions(fetchImpl),
    apiOrigin: "not a url",
  });

  assert.equal(result, null);
  assert.equal(calls.length, 0, "a bad URL must never reach fetch");
});

test("fetchJsonAndParse returns the sentinel on a transport error", async () => {
  const { fetchImpl } = fetchStub("throw");

  const result = await fetchJsonAndParse("/thing", schema, {
    ...baseOptions(fetchImpl),
    sentinel: undefined,
  });

  assert.equal(result, undefined);
});

test("fetchJsonAndParse returns the sentinel on a non-2xx response", async () => {
  const { fetchImpl } = fetchStub(new Response("nope", { status: 401 }));

  const result = await fetchJsonAndParse(
    "/thing",
    schema,
    baseOptions(fetchImpl)
  );

  assert.equal(result, null);
});

test("fetchJsonAndParse returns the sentinel on unparseable JSON", async () => {
  const { fetchImpl } = fetchStub(new Response("<html>", { status: 200 }));

  const result = await fetchJsonAndParse(
    "/thing",
    schema,
    baseOptions(fetchImpl)
  );

  assert.equal(result, null);
});

test("fetchJsonAndParse returns the sentinel on a schema-invalid body", async () => {
  const { fetchImpl } = fetchStub(
    new Response(JSON.stringify({ success: true, data: { value: 1 } }), {
      status: 200,
    })
  );

  const result = await fetchJsonAndParse(
    "/thing",
    schema,
    baseOptions(fetchImpl)
  );

  assert.equal(result, null);
});

/**
 * ISS-8749: attribution is stamped by THIS scaffold, not only by the
 * `fetchSessionJson` façade over it. Several authenticated first-party reads —
 * `/me`, `/users`, the pack-analytics read, the assigned-distributions read —
 * call this helper directly, and stamping only the façade left every one of
 * them looking like traffic from a Desktop build that predates the header.
 */
test("fetchJsonAndParse stamps the published attribution on a direct call", async () => {
  resetDesktopClientAttribution();
  setDesktopClientAttributionResolver(() => ({
    installationId: "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311",
    clientVersion: "1.24.3",
  }));
  const { fetchImpl, calls } = fetchStub(
    new Response(JSON.stringify({ success: true, data: { value: "ok" } }), {
      status: 200,
    })
  );

  await fetchJsonAndParse("/me", schema, baseOptions(fetchImpl));

  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(
    headers[DesktopClientAttributionHeader.InstallationId],
    "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311"
  );
  assert.equal(headers[DesktopClientAttributionHeader.ClientVersion], "1.24.3");
  resetDesktopClientAttribution();
});

/**
 * Negative control: without it the assertion above would still pass against a
 * helper that stamped a hardcoded placeholder on every request.
 */
test("fetchJsonAndParse sends no attribution before one is published", async () => {
  resetDesktopClientAttribution();
  const { fetchImpl, calls } = fetchStub(
    new Response(JSON.stringify({ success: true, data: { value: "ok" } }), {
      status: 200,
    })
  );

  await fetchJsonAndParse("/me", schema, baseOptions(fetchImpl));

  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.ok(
    !Object.hasOwn(headers, DesktopClientAttributionHeader.InstallationId)
  );
  assert.ok(
    !Object.hasOwn(headers, DesktopClientAttributionHeader.ClientVersion)
  );
});

/** A caller header must still win over the attribution merged beneath it. */
test("fetchJsonAndParse lets a caller header outrank the attribution", async () => {
  resetDesktopClientAttribution();
  setDesktopClientAttributionResolver(() => ({ clientVersion: "1.24.3" }));
  const { fetchImpl, calls } = fetchStub(
    new Response(JSON.stringify({ success: true, data: { value: "ok" } }), {
      status: 200,
    })
  );

  await fetchJsonAndParse("/me", schema, {
    ...baseOptions(fetchImpl),
    headers: { [DesktopClientAttributionHeader.ClientVersion]: "9.9.9" },
  });

  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers[DesktopClientAttributionHeader.ClientVersion], "9.9.9");
  resetDesktopClientAttribution();
});
