import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTelemetryOrgProvider,
  type TelemetryOrgApiKeyReader,
} from "../src/main/telemetry-org-identity.js";

const API_ORIGIN = "https://api.example.test";

/** Lets all pending microtasks/promise chains settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type FetchCall = {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | null;
};

/**
 * Minimal fetch double. `respond` returns the next Response (or throws to
 * simulate a network error). Records every call for assertions.
 */
function createFetchDouble(
  respond: () => { status: number; body: unknown } | "throw"
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal ?? null,
    });
    const next = respond();
    if (next === "throw") {
      return Promise.reject(new Error("network down"));
    }
    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: () => Promise.resolve(next.body),
    } as Response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function keyReader(getApiKey: () => string | null): TelemetryOrgApiKeyReader {
  return { getApiKey };
}

const okEnvelope = (organizationId: string) => ({
  status: 200,
  body: { success: true, data: { organizationId, email: "user@example.test" } },
});

test("single-player: no API key never resolves an org and never calls the API", async () => {
  const { fetchImpl, calls } = createFetchDouble(() => okEnvelope("org_never"));
  const provider = createTelemetryOrgProvider({
    apiKeyStore: keyReader(() => null),
    getApiOrigin: () => API_ORIGIN,
    fetchImpl,
  });

  assert.equal(provider.getOrganizationId(), undefined);
  provider.warm();
  await flush();

  assert.equal(provider.getOrganizationId(), undefined);
  assert.equal(calls.length, 0, "single-player must never call /me");
});

test("multiplayer: resolves the org from GET /me and caches it", async () => {
  const { fetchImpl, calls } = createFetchDouble(() => okEnvelope("org_alpha"));
  const provider = createTelemetryOrgProvider({
    apiKeyStore: keyReader(() => "sk_live_alpha"),
    getApiOrigin: () => API_ORIGIN,
    fetchImpl,
  });

  // First call kicks off resolution and returns undefined (best-effort).
  assert.equal(provider.getOrganizationId(), undefined);
  await flush();

  assert.equal(provider.getOrganizationId(), "org_alpha");
  // Cached: no further requests once resolved.
  assert.equal(provider.getOrganizationId(), "org_alpha");
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.ok(request);
  assert.equal(request.url, `${API_ORIGIN}/me`);
  assert.equal(
    (request.headers as Record<string, string>).Authorization,
    "Bearer sk_live_alpha"
  );
  // The request is time-bounded so a stalled /me cannot wedge the de-dup slot.
  assert.ok(
    request.signal instanceof AbortSignal,
    "GET /me must carry an abort signal (timeout)"
  );
});

test("concurrent calls issue a single /me request (de-dup)", async () => {
  const { fetchImpl, calls } = createFetchDouble(() => okEnvelope("org_dedup"));
  const provider = createTelemetryOrgProvider({
    apiKeyStore: keyReader(() => "sk_live_dedup"),
    getApiOrigin: () => API_ORIGIN,
    fetchImpl,
  });

  // Three synchronous reads before the first resolution settles.
  provider.getOrganizationId();
  provider.warm();
  provider.getOrganizationId();
  await flush();

  assert.equal(provider.getOrganizationId(), "org_dedup");
  assert.equal(calls.length, 1);
});

test("key rotation invalidates the cached org and re-resolves", async () => {
  let activeKey = "sk_live_first";
  let orgForCall = "org_first";
  const { fetchImpl, calls } = createFetchDouble(() => okEnvelope(orgForCall));
  const provider = createTelemetryOrgProvider({
    apiKeyStore: keyReader(() => activeKey),
    getApiOrigin: () => API_ORIGIN,
    fetchImpl,
  });

  provider.getOrganizationId();
  await flush();
  assert.equal(provider.getOrganizationId(), "org_first");

  // Rotate the key: the stale org must not leak; a fresh /me resolves it.
  activeKey = "sk_live_second";
  orgForCall = "org_second";
  assert.equal(
    provider.getOrganizationId(),
    undefined,
    "rotated key must invalidate the cached org immediately"
  );
  await flush();
  assert.equal(provider.getOrganizationId(), "org_second");
  assert.equal(calls.length, 2);
});

test("clearing the key mid-session immediately drops the org", async () => {
  let activeKey: string | null = "sk_live_present";
  const { fetchImpl, calls } = createFetchDouble(() => okEnvelope("org_drop"));
  const provider = createTelemetryOrgProvider({
    apiKeyStore: keyReader(() => activeKey),
    getApiOrigin: () => API_ORIGIN,
    fetchImpl,
  });

  provider.getOrganizationId();
  await flush();
  assert.equal(provider.getOrganizationId(), "org_drop");

  activeKey = null;
  assert.equal(
    provider.getOrganizationId(),
    undefined,
    "clearing the key must drop the org with no further /me call"
  );
  await flush();
  assert.equal(calls.length, 1);
});

test("a non-2xx /me leaves the org unresolved and never throws", async () => {
  const provider = createTelemetryOrgProvider({
    apiKeyStore: keyReader(() => "sk_live_5xx"),
    getApiOrigin: () => API_ORIGIN,
    fetchImpl: createFetchDouble(() => ({
      status: 500,
      body: { success: false },
    })).fetchImpl,
  });

  assert.doesNotThrow(() => provider.warm());
  await flush();
  assert.equal(provider.getOrganizationId(), undefined);
});

test("a malformed /me body (no organizationId) leaves the org unresolved", async () => {
  const provider = createTelemetryOrgProvider({
    apiKeyStore: keyReader(() => "sk_live_malformed"),
    getApiOrigin: () => API_ORIGIN,
    fetchImpl: createFetchDouble(() => ({
      status: 200,
      body: { success: true, data: { email: "user@example.test" } },
    })).fetchImpl,
  });

  provider.warm();
  await flush();
  assert.equal(provider.getOrganizationId(), undefined);
});

test("a contract-invalid org id (over length) resolves to undefined and is never attached", async () => {
  // 65 chars exceeds the app.organization.id bound (64); the emit path must
  // never receive a value that would make its schema parse throw.
  const oversizedOrg = "a".repeat(65);
  const provider = createTelemetryOrgProvider({
    apiKeyStore: keyReader(() => "sk_live_oversized"),
    getApiOrigin: () => API_ORIGIN,
    fetchImpl: createFetchDouble(() => okEnvelope(oversizedOrg)).fetchImpl,
  });

  provider.warm();
  await flush();
  assert.equal(provider.getOrganizationId(), undefined);
});

test("a network error never throws and the org resolves on a later success", async () => {
  let mode: "error" | "ok" = "error";
  const provider = createTelemetryOrgProvider({
    apiKeyStore: keyReader(() => "sk_live_retry"),
    getApiOrigin: () => API_ORIGIN,
    fetchImpl: createFetchDouble(() =>
      mode === "error" ? "throw" : okEnvelope("org_eventual")
    ).fetchImpl,
  });

  assert.doesNotThrow(() => provider.warm());
  await flush();
  assert.equal(provider.getOrganizationId(), undefined);
  // Drain the read-triggered resolution before flipping the response so no
  // stale in-flight request occupies the de-dup slot across the transition.
  await flush();

  mode = "ok";
  provider.warm();
  await flush();
  assert.equal(provider.getOrganizationId(), "org_eventual");
});
