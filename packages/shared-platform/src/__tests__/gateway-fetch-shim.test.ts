import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerSurfaceRoutingAdapter,
  resetRoutingAdaptersForTests,
} from "../gateway-dispatch";
import {
  installGatewayFetchShim,
  isGatewayRequest,
  methodAllowsBody,
  resetGatewayFetchShimForTests,
} from "../gateway-fetch-shim";
import type { SurfaceRoutingAdapter } from "../types";

function registerMockAdapter(
  dispatch: (path: string, init?: RequestInit) => Promise<Response>
): () => void {
  const adapter: SurfaceRoutingAdapter = {
    surfaceName: "test",
    dispatchGatewayRequest: dispatch,
    supportsMode: () => true,
  };
  return registerSurfaceRoutingAdapter(adapter);
}

describe("gateway-fetch-shim — pure helpers", () => {
  it("isGatewayRequest matches only the gateway prefix", () => {
    expect(isGatewayRequest(new URL("http://x/api/gateway/git/pr/files"))).toBe(
      true
    );
    expect(isGatewayRequest(new URL("http://x/api/other"))).toBe(false);
    expect(isGatewayRequest(new URL("http://x/api/gateway"))).toBe(false);
  });

  it("methodAllowsBody is false for GET/HEAD only", () => {
    expect(methodAllowsBody("GET")).toBe(false);
    expect(methodAllowsBody("HEAD")).toBe(false);
    expect(methodAllowsBody("POST")).toBe(true);
    expect(methodAllowsBody("DELETE")).toBe(true);
  });
});

describe("installGatewayFetchShim", () => {
  let baseFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("location", { origin: "http://localhost" });
    baseFetch = vi.fn(async () => new Response("base"));
    vi.stubGlobal("fetch", baseFetch);
  });

  afterEach(() => {
    resetGatewayFetchShimForTests();
    resetRoutingAdaptersForTests();
    vi.unstubAllGlobals();
  });

  it("passes non-gateway requests straight through to the original fetch", async () => {
    const adapterDispatch = vi.fn(async () => new Response("adapter"));
    registerMockAdapter(adapterDispatch);
    const handle = installGatewayFetchShim();

    await globalThis.fetch("http://localhost/not-a-gateway");

    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(adapterDispatch).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("delegates gateway requests to the registered adapter", async () => {
    const adapterDispatch = vi.fn(async () => new Response("adapter"));
    registerMockAdapter(adapterDispatch);
    const handle = installGatewayFetchShim();

    await globalThis.fetch("http://localhost/api/gateway/git/pr/files?x=1");

    expect(adapterDispatch).toHaveBeenCalledTimes(1);
    expect(baseFetch).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("is ref-counted: the wrapper survives until the last dispose", () => {
    const first = installGatewayFetchShim();
    const second = installGatewayFetchShim();
    const intercepted = globalThis.fetch;

    expect(first.isFirstInstall).toBe(true);
    expect(second.isFirstInstall).toBe(false);

    expect(second.dispose()).toBe(false);
    expect(globalThis.fetch).toBe(intercepted);

    expect(first.dispose()).toBe(true);
    expect(globalThis.fetch).toBe(first.originalFetch);
  });

  it("HIGH-4: the captured originalFetch does NOT re-enter the shim (no infinite loop)", async () => {
    const handle = installGatewayFetchShim();
    // An adapter that performs its own network call through the captured,
    // pre-interception fetch. If originalFetch were the intercepted wrapper this
    // would recurse forever.
    const adapterDispatch = vi.fn((path: string) => handle.originalFetch(path));
    registerMockAdapter(adapterDispatch);

    await globalThis.fetch("http://localhost/api/gateway/anything");

    expect(adapterDispatch).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    handle.dispose();
  });
});
