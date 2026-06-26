import {
  registerSurfaceRoutingAdapter,
  resetRoutingAdaptersForTests,
} from "@repo/shared-platform/gateway-dispatch";
import {
  getRoutingSelection,
  resetRoutingSelectionForTests,
  setRoutingManualSelection,
} from "@repo/shared-platform/routing-store";
import { EngineerRoutingMode } from "@repo/shared-platform/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopRoutingAdapter,
  ensureDesktopRoutingSelection,
} from "../desktop-routing-adapter";

type DispatchMock = ReturnType<typeof vi.fn>;

function installDispatchMock(impl: DispatchMock): DispatchMock {
  (
    window as unknown as { desktopApi: { dispatchGateway: DispatchMock } }
  ).desktopApi = { dispatchGateway: impl };
  return impl;
}

describe("createDesktopRoutingAdapter — supportsMode", () => {
  it("is desktop + LocalElectron-only (CloudRelay unsupported in v1)", () => {
    const adapter = createDesktopRoutingAdapter();
    expect(adapter.surfaceName).toBe("desktop");
    expect(adapter.supportsMode(EngineerRoutingMode.LocalElectron)).toBe(true);
    expect(adapter.supportsMode(EngineerRoutingMode.CloudRelay)).toBe(false);
  });
});

describe("createDesktopRoutingAdapter — dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a RelayHttpRequestPayload and reconstructs a Response, stripping auth headers", async () => {
    const dispatchGateway = installDispatchMock(
      vi.fn().mockResolvedValue({
        status: 200,
        body: JSON.stringify({ files: ["x.ts"] }),
        headers: { "content-type": "application/json" },
      })
    );

    const adapter = createDesktopRoutingAdapter();
    const response = await adapter.dispatchGatewayRequest(
      "/api/gateway/git/pr/files?owner=o&repo=r&number=1",
      {
        method: "GET",
        headers: {
          authorization: "Bearer sk_live_x",
          cookie: "session=abc",
          "x-desktop-force-approval": "1",
        },
      }
    );

    expect(dispatchGateway).toHaveBeenCalledTimes(1);
    const payload = dispatchGateway.mock.calls[0][0];
    expect(payload.method).toBe("GET");
    expect(payload.path).toBe(
      "/api/gateway/git/pr/files?owner=o&repo=r&number=1"
    );
    expect(payload.body).toEqual({ kind: "none" });
    expect(payload.headers.authorization).toBeUndefined();
    expect(payload.headers.cookie).toBeUndefined();
    expect(payload.headers["x-desktop-force-approval"]).toBeUndefined();

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ files: ["x.ts"] });
  });

  it("does not surface set-cookie from the gateway envelope", async () => {
    installDispatchMock(
      vi.fn().mockResolvedValue({
        status: 200,
        body: JSON.stringify({ files: [] }),
        headers: {
          "content-type": "application/json",
          "set-cookie": "sid=secret",
        },
      })
    );

    const adapter = createDesktopRoutingAdapter();
    const response = await adapter.dispatchGatewayRequest(
      "/api/gateway/git/pr/files?owner=o&repo=r&number=1"
    );

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("returns a 502 Response when the envelope is unparseable", async () => {
    installDispatchMock(vi.fn().mockResolvedValue({ garbage: true }));
    const adapter = createDesktopRoutingAdapter();
    const response = await adapter.dispatchGatewayRequest(
      "/api/gateway/git/pr/files"
    );
    expect(response.status).toBe(502);
  });
});

describe("ensureDesktopRoutingSelection", () => {
  beforeEach(() => {
    resetRoutingAdaptersForTests();
    resetRoutingSelectionForTests();
  });
  afterEach(() => {
    resetRoutingAdaptersForTests();
    resetRoutingSelectionForTests();
  });

  it("repairs an unsupported persisted/manual CloudRelay selection to LocalElectron", () => {
    setRoutingManualSelection(EngineerRoutingMode.CloudRelay, "target-1");
    registerSurfaceRoutingAdapter(createDesktopRoutingAdapter());

    ensureDesktopRoutingSelection();

    expect(getRoutingSelection().mode).toBe(EngineerRoutingMode.LocalElectron);
  });

  it("leaves a supported LocalElectron selection untouched (idempotent)", () => {
    registerSurfaceRoutingAdapter(createDesktopRoutingAdapter());
    setRoutingManualSelection(EngineerRoutingMode.LocalElectron, null);

    ensureDesktopRoutingSelection();

    const selection = getRoutingSelection();
    expect(selection.mode).toBe(EngineerRoutingMode.LocalElectron);
    expect(selection.source).toBe("manual");
  });
});
