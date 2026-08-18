/**
 * Behavioral tests for the web surface routing adapter's two dispatch
 * branches — CloudRelay command signing and LocalElectron localhost
 * dispatch.
 *
 * Sibling of `web-surface-routing-adapter.test.ts`, which covers
 * `supportsMode` and per-dispatch mode re-reading. Split so neither file
 * approaches the 1000-line ceiling.
 *
 * The signing body encoder and the localhost retry path are private, so every
 * assertion here drives the exported `dispatchGatewayRequest` entry point and
 * asserts on what the adapter actually handed to the signer or to fetch.
 */
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_ID_HEADER,
  COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER,
  COMMAND_SIGNATURE_HEADER,
  COMMAND_SIGNATURE_PAYLOAD_HEADER,
  COMPUTE_TARGET_HEADER,
} from "@/lib/desktop-command-signing/constants";
import { GATEWAY_RELAY_PATH_PREFIX } from "@/lib/engineer/constants";

const mockGetRoutingSelection = vi.hoisted(() => vi.fn());
const mockGetElectronDetectionSnapshot = vi.hoisted(() => vi.fn());
const mockEnsureElectronDetection = vi.hoisted(() => vi.fn());
const mockInvalidateElectronDetectionCache = vi.hoisted(() => vi.fn());
const mockEnsureLocalGatewaySession = vi.hoisted(() => vi.fn());
const mockInvalidateLocalGatewaySession = vi.hoisted(() => vi.fn());
const mockGetLastExchangeError = vi.hoisted(() => vi.fn());
const mockEnsureLocalGatewayApiNamespace = vi.hoisted(() => vi.fn());
const mockInvalidateLocalGatewayApiNamespace = vi.hoisted(() => vi.fn());
const mockGetCachedComputeTargetForSigning = vi.hoisted(() => vi.fn());
const mockHasEffectiveCommandSigningSupport = vi.hoisted(() => vi.fn());
const mockSignDesktopCommand = vi.hoisted(() => vi.fn());

vi.mock("@/lib/engineer/routing-store", () => ({
  getEngineerRoutingSelection: mockGetRoutingSelection,
}));

vi.mock("@/lib/engineer/constants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/engineer/constants")>();
  return { ...actual, CLOUD_RELAY_ENABLED: true };
});

vi.mock("@/lib/engineer/electron-detection", () => ({
  getElectronDetectionSnapshot: mockGetElectronDetectionSnapshot,
  ensureElectronDetection: mockEnsureElectronDetection,
  invalidateElectronDetectionCache: mockInvalidateElectronDetectionCache,
}));

vi.mock("@/lib/engineer/local-gateway-session", () => ({
  ensureLocalGatewaySession: mockEnsureLocalGatewaySession,
  invalidateLocalGatewaySession: mockInvalidateLocalGatewaySession,
  getLastExchangeError: mockGetLastExchangeError,
}));

vi.mock("@/lib/engineer/local-gateway-api-namespace", () => ({
  ensureLocalGatewayApiNamespace: mockEnsureLocalGatewayApiNamespace,
  invalidateLocalGatewayApiNamespace: mockInvalidateLocalGatewayApiNamespace,
}));

vi.mock("@/lib/desktop-command-signing/compute-target-signing-cache", () => ({
  getCachedComputeTargetForSigning: mockGetCachedComputeTargetForSigning,
}));

vi.mock("@/lib/desktop-command-signing/command-signer", () => ({
  hasEffectiveCommandSigningSupport: mockHasEffectiveCommandSigningSupport,
  signDesktopCommand: mockSignDesktopCommand,
}));

const { createWebSurfaceRoutingAdapter } = await import(
  "@/lib/engineer/web-surface-routing-adapter"
);

const ORIGIN = "http://localhost:3000";
const TARGET_ID = "target-1";
const SIGNED = {
  commandId: "cmd-1",
  signature: "sig",
  signaturePayload: "payload",
  publicKeyFingerprint: "fp",
};

function useCloudRelayRouting(): void {
  mockGetRoutingSelection.mockReturnValue({
    mode: EngineerRoutingMode.CloudRelay,
    computeTargetId: TARGET_ID,
    source: "manual",
    updatedAt: 0,
  });
}

function useLocalElectronRouting(): void {
  mockGetRoutingSelection.mockReturnValue({
    mode: EngineerRoutingMode.LocalElectron,
    computeTargetId: null,
    source: "manual",
    updatedAt: 0,
  });
}

/** Turn on a signing-capable cached compute target. */
function enableCommandSigning(): void {
  mockGetCachedComputeTargetForSigning.mockReturnValue({ id: TARGET_ID });
  mockHasEffectiveCommandSigningSupport.mockReturnValue(true);
  mockSignDesktopCommand.mockResolvedValue(SIGNED);
}

/** The signing input the adapter actually built for this dispatch. */
function signedBodyArgument(): unknown {
  return mockSignDesktopCommand.mock.calls[0][0].body;
}

function makeAdapter(originalFetch: ReturnType<typeof vi.fn>) {
  return createWebSurfaceRoutingAdapter(
    originalFetch as unknown as typeof globalThis.fetch
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCachedComputeTargetForSigning.mockReturnValue(null);
  mockHasEffectiveCommandSigningSupport.mockReturnValue(false);
  mockGetLastExchangeError.mockReturnValue(null);
  mockEnsureLocalGatewaySession.mockResolvedValue("session-token");
  mockEnsureLocalGatewayApiNamespace.mockResolvedValue(null);
  mockGetElectronDetectionSnapshot.mockReturnValue({
    detected: true,
    loading: false,
    port: 4711,
    checkedAt: Date.now(),
  });
});

describe("CloudRelay dispatch — command signing body encoding", () => {
  it("signs a JSON body as parsed JSON rather than as an opaque string", async () => {
    useCloudRelayRouting();
    enableCommandSigning();
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "a/b", count: 2 }),
      }
    );

    expect(signedBodyArgument()).toEqual({ repo: "a/b", count: 2 });
  });

  it("signs a text body as its decoded text", async () => {
    useCloudRelayRouting();
    enableCommandSigning();
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello world",
      }
    );

    expect(signedBodyArgument()).toBe("hello world");
  });

  it("signs a form-urlencoded body as its decoded text", async () => {
    useCloudRelayRouting();
    enableCommandSigning();
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1&b=2",
      }
    );

    expect(signedBodyArgument()).toBe("a=1&b=2");
  });

  it("base64-encodes an opaque binary body for signing", async () => {
    useCloudRelayRouting();
    enableCommandSigning();
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3]),
      }
    );

    // base64 of the raw bytes 0x01 0x02 0x03
    expect(signedBodyArgument()).toBe("AQID");
  });

  it("signs no body for a bodyless GET", async () => {
    useCloudRelayRouting();
    enableCommandSigning();
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "GET" }
    );

    expect(signedBodyArgument()).toBeUndefined();
  });

  it("signs no body for a POST with an empty payload", async () => {
    useCloudRelayRouting();
    enableCommandSigning();
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "POST", headers: { "content-type": "application/json" } }
    );

    expect(signedBodyArgument()).toBeUndefined();
  });
});

describe("CloudRelay dispatch — signing failures", () => {
  it("fails a malformed JSON body with 400 and never sends it to the relay", async () => {
    useCloudRelayRouting();
    enableCommandSigning();
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ broken",
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON body",
    });
    expect(originalFetch).not.toHaveBeenCalled();
  });

  it("reports a signer failure as an unavailable 503 carrying the signer's message", async () => {
    useCloudRelayRouting();
    enableCommandSigning();
    mockSignDesktopCommand.mockRejectedValue(new Error("Keychain locked"));
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "POST", body: "x" }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Keychain locked",
    });
    expect(originalFetch).not.toHaveBeenCalled();
  });

  it("falls back to a generic signing message when the signer throws a non-Error", async () => {
    useCloudRelayRouting();
    enableCommandSigning();
    mockSignDesktopCommand.mockRejectedValue("boom");
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "POST", body: "x" }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Command signing failed",
    });
  });
});

describe("CloudRelay dispatch — outgoing request shape", () => {
  it("attaches all four signing headers plus the compute target", async () => {
    useCloudRelayRouting();
    enableCommandSigning();
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git?ref=main`,
      { method: "POST", body: "x" }
    );

    const sent = originalFetch.mock.calls[0][0] as Request;
    expect(sent.headers.get(COMPUTE_TARGET_HEADER)).toBe(TARGET_ID);
    expect(sent.headers.get(COMMAND_ID_HEADER)).toBe(SIGNED.commandId);
    expect(sent.headers.get(COMMAND_SIGNATURE_HEADER)).toBe(SIGNED.signature);
    expect(sent.headers.get(COMMAND_SIGNATURE_PAYLOAD_HEADER)).toBe(
      SIGNED.signaturePayload
    );
    expect(sent.headers.get(COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER)).toBe(
      SIGNED.publicKeyFingerprint
    );
  });

  it("signs the original gateway path and query, not the rewritten relay path", async () => {
    useCloudRelayRouting();
    enableCommandSigning();
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git?ref=main`,
      { method: "POST", body: "x" }
    );

    expect(mockSignDesktopCommand.mock.calls[0][0].pathWithQuery).toBe(
      "/api/gateway/git?ref=main"
    );
    const sent = originalFetch.mock.calls[0][0] as Request;
    expect(new URL(sent.url).pathname).toBe(`${GATEWAY_RELAY_PATH_PREFIX}git`);
    expect(new URL(sent.url).search).toBe("?ref=main");
  });

  it("skips signing for a target without command-signing support but still tags the target", async () => {
    useCloudRelayRouting();
    mockGetCachedComputeTargetForSigning.mockReturnValue({ id: TARGET_ID });
    mockHasEffectiveCommandSigningSupport.mockReturnValue(false);
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "POST", body: "x" }
    );

    expect(mockSignDesktopCommand).not.toHaveBeenCalled();
    const sent = originalFetch.mock.calls[0][0] as Request;
    expect(sent.headers.get(COMPUTE_TARGET_HEADER)).toBe(TARGET_ID);
    expect(sent.headers.get(COMMAND_SIGNATURE_HEADER)).toBeNull();
  });

  it("skips signing when no cached target is available", async () => {
    useCloudRelayRouting();
    mockGetCachedComputeTargetForSigning.mockReturnValue(null);
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "GET" }
    );

    expect(mockSignDesktopCommand).not.toHaveBeenCalled();
    expect(originalFetch).toHaveBeenCalledTimes(1);
  });
});

describe("LocalElectron dispatch — localhost routing", () => {
  it("sends the request to the detected localhost port", async () => {
    useLocalElectronRouting();
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git?ref=main`,
      { method: "GET" }
    );

    const sent = originalFetch.mock.calls[0][0] as Request;
    const url = new URL(sent.url);
    expect(url.host).toBe("localhost:4711");
    expect(url.pathname).toBe("/api/gateway/git");
    expect(url.search).toBe("?ref=main");
  });

  it("runs detection first when no detection has been attempted yet", async () => {
    useLocalElectronRouting();
    mockGetElectronDetectionSnapshot.mockReturnValue({
      detected: false,
      loading: false,
      port: null,
      checkedAt: null,
    });
    mockEnsureElectronDetection.mockResolvedValue({
      detected: true,
      loading: false,
      port: 5999,
      checkedAt: Date.now(),
    });
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "GET" }
    );

    expect(mockEnsureElectronDetection).toHaveBeenCalledTimes(1);
    const sent = originalFetch.mock.calls[0][0] as Request;
    expect(new URL(sent.url).host).toBe("localhost:5999");
  });

  it("passes the request through untouched when Electron is not detected", async () => {
    useLocalElectronRouting();
    mockGetElectronDetectionSnapshot.mockReturnValue({
      detected: false,
      loading: false,
      port: null,
      checkedAt: Date.now(),
    });
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "GET" }
    );

    const sent = originalFetch.mock.calls[0][0] as Request;
    expect(new URL(sent.url).host).toBe("localhost:3000");
    expect(mockEnsureLocalGatewaySession).not.toHaveBeenCalled();
  });

  it("returns the session exchange error instead of sending a doomed request", async () => {
    useLocalElectronRouting();
    mockEnsureLocalGatewaySession.mockResolvedValue(null);
    mockGetLastExchangeError.mockReturnValue({
      message: "Missing API key",
      statusCode: 503,
    });
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    const response = await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "GET" }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Missing API key",
    });
    expect(originalFetch).not.toHaveBeenCalled();
  });

  it("still dispatches when the session is absent but no actionable error was recorded", async () => {
    useLocalElectronRouting();
    mockEnsureLocalGatewaySession.mockResolvedValue(null);
    mockGetLastExchangeError.mockReturnValue(null);
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "GET" }
    );

    expect(originalFetch).toHaveBeenCalledTimes(1);
  });
});

describe("LocalElectron dispatch — 401 retry", () => {
  it("invalidates caches and retries once with a fresh token on a 401", async () => {
    useLocalElectronRouting();
    mockEnsureLocalGatewaySession
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");
    const originalFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "GET" }
    );

    expect(response.status).toBe(200);
    expect(originalFetch).toHaveBeenCalledTimes(2);
    expect(mockInvalidateLocalGatewaySession).toHaveBeenCalledTimes(1);
    expect(mockInvalidateLocalGatewayApiNamespace).toHaveBeenCalledWith(4711);
  });

  it("returns the original 401 when the retry cannot obtain a fresh token", async () => {
    useLocalElectronRouting();
    mockEnsureLocalGatewaySession
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce(null);
    mockGetLastExchangeError.mockReturnValue(null);
    const originalFetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 401 }));

    const response = await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "GET" }
    );

    expect(response.status).toBe(401);
    expect(originalFetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces an exchange error raised during the retry", async () => {
    useLocalElectronRouting();
    mockEnsureLocalGatewaySession
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce(null);
    // The first dispatch holds a (stale) token, so the exchange error is only
    // consulted inside the retry.
    mockGetLastExchangeError.mockReturnValue({
      message: "Key revoked",
      statusCode: 403,
    });
    const originalFetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 401 }));

    const response = await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "GET" }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Key revoked" });
  });

  it("does not retry a 401 when no session token was ever obtained", async () => {
    useLocalElectronRouting();
    mockEnsureLocalGatewaySession.mockResolvedValue(null);
    mockGetLastExchangeError.mockReturnValue(null);
    const originalFetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 401 }));

    const response = await makeAdapter(originalFetch).dispatchGatewayRequest(
      `${ORIGIN}/api/gateway/git`,
      { method: "GET" }
    );

    expect(response.status).toBe(401);
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(mockInvalidateLocalGatewaySession).not.toHaveBeenCalled();
  });
});

describe("LocalElectron dispatch — transport failure", () => {
  it("invalidates the detection, session and namespace caches when the socket is gone", async () => {
    useLocalElectronRouting();
    const originalFetch = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      makeAdapter(originalFetch).dispatchGatewayRequest(
        `${ORIGIN}/api/gateway/git`,
        { method: "GET" }
      )
    ).rejects.toThrow("Failed to fetch");

    expect(mockInvalidateElectronDetectionCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateLocalGatewaySession).toHaveBeenCalledTimes(1);
    expect(mockInvalidateLocalGatewayApiNamespace).toHaveBeenCalledWith(4711);
  });

  it("leaves the caches intact for a non-transport error", async () => {
    useLocalElectronRouting();
    const originalFetch = vi
      .fn()
      .mockRejectedValue(new RangeError("something else"));

    await expect(
      makeAdapter(originalFetch).dispatchGatewayRequest(
        `${ORIGIN}/api/gateway/git`,
        { method: "GET" }
      )
    ).rejects.toThrow("something else");

    expect(mockInvalidateElectronDetectionCache).not.toHaveBeenCalled();
  });
});
