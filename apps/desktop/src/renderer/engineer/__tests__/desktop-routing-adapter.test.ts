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

/**
 * ISS-5301: request-body encoding and response reconstruction.
 *
 * The adapter is the renderer half of a cross-process wire contract, so the
 * encodings it emits and the Fetch-spec rules it honors on the way back are
 * contract behavior, not implementation detail — a body shape it silently
 * mis-encodes, or a null-body status it tries to give a body to, fails inside
 * main (or throws constructing the Response) rather than at the call site.
 */

describe("createDesktopRoutingAdapter — request body encoding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to GET and sends no body when no init is supplied", async () => {
    const dispatchGateway = installDispatchMock(
      vi.fn().mockResolvedValue({ status: 200, body: "{}" })
    );

    await createDesktopRoutingAdapter().dispatchGatewayRequest(
      "/api/gateway/git/status"
    );

    const payload = dispatchGateway.mock.calls[0][0];
    expect(payload.method).toBe("GET");
    expect(payload.body).toEqual({ kind: "none" });
  });

  it("uppercases a lowercase method", async () => {
    const dispatchGateway = installDispatchMock(
      vi.fn().mockResolvedValue({ status: 200, body: "{}" })
    );

    await createDesktopRoutingAdapter().dispatchGatewayRequest(
      "/api/gateway/git/status",
      { method: "post", body: "{}" }
    );

    expect(dispatchGateway.mock.calls[0][0].method).toBe("POST");
  });

  it("sends a string body as text, carrying its content type", async () => {
    const dispatchGateway = installDispatchMock(
      vi.fn().mockResolvedValue({ status: 200, body: "{}" })
    );

    await createDesktopRoutingAdapter().dispatchGatewayRequest(
      "/api/gateway/git/commit",
      {
        method: "POST",
        body: '{"message":"hi"}',
        headers: { "content-type": "application/json" },
      }
    );

    expect(dispatchGateway.mock.calls[0][0].body).toEqual({
      kind: "text",
      value: '{"message":"hi"}',
      contentType: "application/json",
    });
  });

  it("reports a null content type when the caller sent no header", async () => {
    const dispatchGateway = installDispatchMock(
      vi.fn().mockResolvedValue({ status: 200, body: "{}" })
    );

    await createDesktopRoutingAdapter().dispatchGatewayRequest(
      "/api/gateway/git/commit",
      { method: "POST", body: "raw" }
    );

    expect(dispatchGateway.mock.calls[0][0].body).toEqual({
      kind: "text",
      value: "raw",
      contentType: null,
    });
  });

  it("base64-encodes an ArrayBuffer body", async () => {
    const dispatchGateway = installDispatchMock(
      vi.fn().mockResolvedValue({ status: 200, body: "{}" })
    );
    // "hi" — the shared fetch shim materializes bodies to an ArrayBuffer
    // before dispatch, so this is the shape non-text bodies really arrive in.
    const buffer = new Uint8Array([104, 105]).buffer;

    await createDesktopRoutingAdapter().dispatchGatewayRequest(
      "/api/gateway/git/commit",
      { method: "POST", body: buffer }
    );

    expect(dispatchGateway.mock.calls[0][0].body).toEqual({
      kind: "base64",
      value: btoa("hi"),
      contentType: null,
    });
  });

  it("sends no body when a body-bearing method carries none", async () => {
    const dispatchGateway = installDispatchMock(
      vi.fn().mockResolvedValue({ status: 200, body: "{}" })
    );

    await createDesktopRoutingAdapter().dispatchGatewayRequest(
      "/api/gateway/git/commit",
      { method: "POST" }
    );

    expect(dispatchGateway.mock.calls[0][0].body).toEqual({ kind: "none" });
  });

  it("refuses a body shape the wire contract cannot carry", async () => {
    installDispatchMock(vi.fn().mockResolvedValue({ status: 200, body: "{}" }));

    await expect(
      createDesktopRoutingAdapter().dispatchGatewayRequest(
        "/api/gateway/git/commit",
        { method: "POST", body: new URLSearchParams({ a: "b" }) }
      )
    ).rejects.toThrow("unsupported request body");
  });
});

describe("createDesktopRoutingAdapter — response reconstruction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes a non-string envelope body back to JSON text", async () => {
    installDispatchMock(
      vi.fn().mockResolvedValue({ status: 200, body: { files: ["a.ts"] } })
    );

    const response = await createDesktopRoutingAdapter().dispatchGatewayRequest(
      "/api/gateway/git/pr/files"
    );

    await expect(response.json()).resolves.toEqual({ files: ["a.ts"] });
  });

  it("defaults the content type when the envelope declares none", async () => {
    installDispatchMock(vi.fn().mockResolvedValue({ status: 200, body: "{}" }));

    const response = await createDesktopRoutingAdapter().dispatchGatewayRequest(
      "/api/gateway/git/status"
    );

    expect(response.headers.get("content-type")).toBe("application/json");
  });

  // 204/205/304 only. `isNullBodyStatus` also claims the 1xx range, but that
  // arm is unreachable through this function: `new Response()` rejects any
  // status outside 200-599, so a 1xx envelope throws a RangeError out of
  // `toResponse` before the null-body choice is ever used. Covered as-is rather
  // than pinned — see the PR note; asserting the RangeError would enshrine it.
  it.each([
    204, 205, 304,
  ])("gives status %i no body, per the Fetch spec", async (status) => {
    installDispatchMock(
      vi.fn().mockResolvedValue({ status, body: "should be dropped" })
    );

    const response = await createDesktopRoutingAdapter().dispatchGatewayRequest(
      "/api/gateway/git/status"
    );

    expect(response.status).toBe(status);
    await expect(response.text()).resolves.toBe("");
  });

  it("keeps the body on a status that permits one", async () => {
    installDispatchMock(
      vi.fn().mockResolvedValue({ status: 200, body: "kept" })
    );

    const response = await createDesktopRoutingAdapter().dispatchGatewayRequest(
      "/api/gateway/git/status"
    );

    await expect(response.text()).resolves.toBe("kept");
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
