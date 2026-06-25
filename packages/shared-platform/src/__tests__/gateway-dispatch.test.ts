import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchGatewayRequest,
  getRegisteredRoutingAdapters,
  NoRoutingAdapterError,
  registerSurfaceRoutingAdapter,
  resetRoutingAdaptersForTests,
  selectRoutingAdapter,
  unregisterSurfaceRoutingAdapter,
} from "../gateway-dispatch";
import { EngineerRoutingMode, type SurfaceRoutingAdapter } from "../types";

type RecordedCall = { path: string; init?: RequestInit };

function mockAdapter(
  surfaceName: string,
  modes: EngineerRoutingMode[],
  response = new Response("ok", { status: 200 })
): { adapter: SurfaceRoutingAdapter; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const adapter: SurfaceRoutingAdapter = {
    surfaceName,
    supportsMode: (mode) => modes.includes(mode),
    dispatchGatewayRequest: (path, init) => {
      calls.push({ path, init });
      return Promise.resolve(response);
    },
  };
  return { adapter, calls };
}

const selection = (mode: EngineerRoutingMode) => ({
  mode,
  computeTargetId: null,
  source: "auto" as const,
  updatedAt: 0,
});

afterEach(() => {
  resetRoutingAdaptersForTests();
});

describe("adapter registry lifecycle", () => {
  it("registers an adapter and exposes it", () => {
    const { adapter } = mockAdapter("web", [EngineerRoutingMode.CloudRelay]);
    registerSurfaceRoutingAdapter(adapter);
    expect(getRegisteredRoutingAdapters()).toContain(adapter);
  });

  it("the returned disposer removes exactly that adapter", () => {
    const { adapter } = mockAdapter("web", [EngineerRoutingMode.CloudRelay]);
    const dispose = registerSurfaceRoutingAdapter(adapter);
    dispose();
    expect(getRegisteredRoutingAdapters()).not.toContain(adapter);
  });

  it("is idempotent under double-registration (Strict Mode remount)", () => {
    const { adapter } = mockAdapter("web", [EngineerRoutingMode.CloudRelay]);
    registerSurfaceRoutingAdapter(adapter);
    registerSurfaceRoutingAdapter(adapter);
    expect(getRegisteredRoutingAdapters()).toHaveLength(1);
  });

  it("unregisterSurfaceRoutingAdapter removes the adapter", () => {
    const { adapter } = mockAdapter("web", [EngineerRoutingMode.CloudRelay]);
    registerSurfaceRoutingAdapter(adapter);
    unregisterSurfaceRoutingAdapter(adapter);
    expect(getRegisteredRoutingAdapters()).toHaveLength(0);
  });
});

describe("selectRoutingAdapter", () => {
  it("returns the adapter that supports the mode", () => {
    const local = mockAdapter("desktop", [EngineerRoutingMode.LocalElectron]);
    const cloud = mockAdapter("web", [EngineerRoutingMode.CloudRelay]);
    registerSurfaceRoutingAdapter(local.adapter);
    registerSurfaceRoutingAdapter(cloud.adapter);
    expect(selectRoutingAdapter(EngineerRoutingMode.CloudRelay)).toBe(
      cloud.adapter
    );
  });

  it("returns null when no adapter supports the mode", () => {
    const local = mockAdapter("desktop", [EngineerRoutingMode.LocalElectron]);
    registerSurfaceRoutingAdapter(local.adapter);
    expect(selectRoutingAdapter(EngineerRoutingMode.CloudRelay)).toBeNull();
  });

  it("returns the earliest-registered supporting adapter", () => {
    const first = mockAdapter("a", [EngineerRoutingMode.CloudRelay]);
    const second = mockAdapter("b", [EngineerRoutingMode.CloudRelay]);
    registerSurfaceRoutingAdapter(first.adapter);
    registerSurfaceRoutingAdapter(second.adapter);
    expect(selectRoutingAdapter(EngineerRoutingMode.CloudRelay)).toBe(
      first.adapter
    );
  });
});

describe("dispatchGatewayRequest", () => {
  it("delegates to the adapter for the supplied selection's mode", async () => {
    const local = mockAdapter("desktop", [EngineerRoutingMode.LocalElectron]);
    const cloud = mockAdapter("web", [EngineerRoutingMode.CloudRelay]);
    registerSurfaceRoutingAdapter(local.adapter);
    registerSurfaceRoutingAdapter(cloud.adapter);

    const init = { method: "POST" };
    const res = await dispatchGatewayRequest(
      "/api/gateway/x",
      init,
      selection(EngineerRoutingMode.CloudRelay)
    );

    expect(res.status).toBe(200);
    expect(cloud.calls).toEqual([{ path: "/api/gateway/x", init }]);
    expect(local.calls).toHaveLength(0);
  });

  it("rejects with NoRoutingAdapterError when no adapter supports the mode", async () => {
    const local = mockAdapter("desktop", [EngineerRoutingMode.LocalElectron]);
    registerSurfaceRoutingAdapter(local.adapter);

    await expect(
      dispatchGatewayRequest(
        "/api/gateway/x",
        undefined,
        selection(EngineerRoutingMode.CloudRelay)
      )
    ).rejects.toBeInstanceOf(NoRoutingAdapterError);
  });

  it("defaults the selection to the shared routing store", async () => {
    // Default arg reads getRoutingSelection(); the store defaults to CloudRelay.
    const cloud = mockAdapter("web", [EngineerRoutingMode.CloudRelay]);
    registerSurfaceRoutingAdapter(cloud.adapter);

    await dispatchGatewayRequest("/api/gateway/health");

    expect(cloud.calls).toEqual([
      { path: "/api/gateway/health", init: undefined },
    ]);
  });

  it("carries the offending mode on the error", async () => {
    const err = await dispatchGatewayRequest(
      "/api/gateway/x",
      undefined,
      selection(EngineerRoutingMode.LocalElectron)
    ).catch((e) => e);
    expect(err).toBeInstanceOf(NoRoutingAdapterError);
    expect((err as NoRoutingAdapterError).mode).toBe(
      EngineerRoutingMode.LocalElectron
    );
  });
});
