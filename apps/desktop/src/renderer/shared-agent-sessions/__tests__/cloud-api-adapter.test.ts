import { ApiError } from "@repo/app/shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  LONG_RUNNING_API_TIMEOUT_MS,
} from "@repo/app/shared/api/api-timeout";
import { shouldRetryQuery } from "@repo/app/shared/query/query-client";
import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_API_FETCH_MAX_TIMEOUT_MS,
  CloudApiFetchErrorReason,
  type CloudApiFetchRequest,
  type CloudApiFetchResult,
  DESKTOP_CLOUD_API_PLACEHOLDER_ORIGIN,
} from "../../../shared/cloud-api-fetch-contract";
import type { DesktopApi } from "../../types/desktop-api";
import { createDesktopCloudApiAdapter } from "../cloud-api-adapter";

const OK_RESULT: CloudApiFetchResult = {
  kind: "response",
  status: 200,
  statusText: "OK",
  headers: [["content-type", "application/json"]],
  bodyText: JSON.stringify({ success: true, data: { id: "s-1" } }),
};

function setup(result: CloudApiFetchResult = OK_RESULT) {
  const cloudApiFetch = vi.fn((_request: CloudApiFetchRequest) =>
    Promise.resolve(result)
  );
  const adapter = createDesktopCloudApiAdapter({
    cloudApiFetch,
  } as unknown as DesktopApi);
  const doFetch = adapter.fetch;
  if (!doFetch) {
    throw new Error("adapter must provide a fetch implementation");
  }
  return { adapter, doFetch, cloudApiFetch };
}

function bridgeUrl(pathAndQuery: string): string {
  return `${DESKTOP_CLOUD_API_PLACEHOLDER_ORIGIN}${pathAndQuery}`;
}

describe("createDesktopCloudApiAdapter", () => {
  it("resolves the non-routable placeholder origin", () => {
    const { adapter } = setup();
    expect(adapter.resolveApiOrigin()).toBe(
      DESKTOP_CLOUD_API_PLACEHOLDER_ORIGIN
    );
  });

  it("marshals path+query over the bridge and synthesizes a faithful Response", async () => {
    const { doFetch, cloudApiFetch } = setup();

    const response = await doFetch(bridgeUrl("/agent-sessions?limit=10"), {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    expect(cloudApiFetch).toHaveBeenCalledWith({
      path: "/agent-sessions?limit=10",
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    // Absent body is omitted entirely, not serialized as an explicit
    // `undefined` across the IPC boundary.
    expect(Object.hasOwn(cloudApiFetch.mock.calls[0][0], "body")).toBe(false);
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { id: "s-1" },
    });
  });

  it("resolves (not rejects) HTTP error statuses, mirroring platform fetch", async () => {
    const { doFetch } = setup({
      kind: "response",
      status: 403,
      statusText: "Forbidden",
      headers: [["content-type", "application/json"]],
      bodyText: JSON.stringify({ success: false, error: "nope" }),
    });
    const response = await doFetch(bridgeUrl("/agent-sessions"));
    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("nope");
  });

  it("synthesizes a null body for 204 responses", async () => {
    const { doFetch } = setup({
      kind: "response",
      status: 204,
      statusText: "No Content",
      headers: [],
      bodyText: "",
    });
    const response = await doFetch(bridgeUrl("/agent-sessions/s-1"), {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("rejects malformed bridge results as transport failures", async () => {
    for (const malformed of [
      { kind: "banana" },
      {
        kind: "response",
        status: "200",
        statusText: "OK",
        headers: [],
        bodyText: "",
      },
      { kind: "response", status: 200, statusText: "OK", headers: [] },
      null,
    ]) {
      const { doFetch } = setup(malformed as unknown as CloudApiFetchResult);
      await expect(doFetch(bridgeUrl("/agent-sessions"))).rejects.toThrow(
        TypeError
      );
    }
  });

  it("rejects with TypeError on a bridge network error (ApiError status-0 path)", async () => {
    const { doFetch } = setup({
      kind: "network-error",
      message: "socket hang up",
    });
    await expect(doFetch(bridgeUrl("/agent-sessions"))).rejects.toThrow(
      new TypeError("socket hang up")
    );
  });

  it("surfaces a main-classified deadline expiry as the client's timeout error", async () => {
    // ISS-5082. Main's timer is the authoritative deadline on desktop, so
    // without this mapping a deadline expiry arrives as an anonymous transport
    // failure that `toApiClientError` wraps as `ApiError(msg, 0)` with no code
    // — desktop could never reach the ISS-5013 "we stopped waiting" surface,
    // and an expiry was indistinguishable from a dropped socket.
    const { doFetch } = setup({
      kind: "network-error",
      message: "The operation was aborted due to timeout",
      reason: CloudApiFetchErrorReason.Timeout,
    });

    const error = await doFetch(bridgeUrl("/agent-sessions")).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isTimeout()).toBe(true);
    expect((error as ApiError).code).toBe(API_TIMEOUT_ERROR_CODE);
    expect((error as ApiError).status).toBe(API_NO_RESPONSE_STATUS);
    // Pinned as a property of the classified error, NOT as a delta: the
    // unlabeled path already failed fast (`isResponseBackedError` short-
    // circuits on any `ApiError`). This guards against a future change that
    // makes a timeout retryable, which would reinstate the minutes-of-fake-
    // loading failure the deadline exists to end.
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it("degrades an absent or unknown reason to the generic network error", async () => {
    // Version skew in both directions: an older main omits the field, a newer
    // one may send a member this renderer has never heard of. Both must behave
    // exactly as they did before the discriminator existed.
    for (const reason of [undefined, "connection-refused"]) {
      const { doFetch } = setup({
        kind: "network-error",
        message: "socket hang up",
        // Deliberately unvalidated: this is the wire shape a skewed peer can
        // actually send, which the compile-time union does not constrain.
        ...(reason === undefined ? {} : { reason }),
      } as CloudApiFetchResult);

      const error = await doFetch(bridgeUrl("/agent-sessions")).catch(
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(ApiError);
      expect((error as TypeError).message).toBe("socket hang up");
    }
  });

  it("blocks cross-origin URLs without touching the bridge", async () => {
    const { doFetch, cloudApiFetch } = setup();
    await expect(doFetch("https://evil.example/steal")).rejects.toThrow(
      TypeError
    );
    expect(cloudApiFetch).not.toHaveBeenCalled();
  });

  it("drops the Authorization sentinel before it crosses the bridge", async () => {
    const { doFetch, cloudApiFetch } = setup();
    await doFetch(bridgeUrl("/agent-sessions"), {
      headers: {
        Authorization: "Bearer sentinel",
        "Content-Type": "application/json",
      },
    });
    expect(cloudApiFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("flattens Headers instances", async () => {
    const { doFetch, cloudApiFetch } = setup();
    await doFetch(bridgeUrl("/agent-sessions"), {
      headers: new Headers({
        authorization: "Bearer sentinel",
        accept: "application/json",
      }),
    });
    expect(cloudApiFetch).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { accept: "application/json" } })
    );
  });

  it("passes string bodies through and rejects non-string bodies", async () => {
    const { doFetch, cloudApiFetch } = setup();
    await doFetch(bridgeUrl("/agent-sessions"), {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    expect(cloudApiFetch).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", body: '{"a":1}' })
    );

    await expect(
      doFetch(bridgeUrl("/agent-sessions"), {
        method: "POST",
        body: new Blob(["x"]),
      })
    ).rejects.toThrow(TypeError);
  });

  it("rejects Request-object inputs explicitly", async () => {
    const { doFetch, cloudApiFetch } = setup();
    await expect(
      doFetch(new Request(bridgeUrl("/agent-sessions")))
    ).rejects.toThrow(TypeError);
    expect(cloudApiFetch).not.toHaveBeenCalled();
  });

  it("forwards the shared client's resolved deadline across the bridge", async () => {
    // ISS-5082: an AbortSignal cannot cross IPC, so this number is the only way
    // a per-call override can outlive the main process's 60s default.
    const { doFetch, cloudApiFetch } = setup();
    await doFetch(bridgeUrl("/agent-sessions"), {
      timeoutMs: LONG_RUNNING_API_TIMEOUT_MS,
    });
    expect(cloudApiFetch).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: LONG_RUNNING_API_TIMEOUT_MS })
    );
  });

  it("caps the bridge at exactly the longest deadline the client can ask for", () => {
    // The main process cannot import `@repo/app`, so its clamp ceiling is a
    // restatement of the shared constant. This is the executable coupling: if
    // the client's longest deadline is raised and the bridge's ceiling is not,
    // main would silently clamp every legitimate long request back down —
    // reproducing the bug ISS-5082 fixed. A NEW, longer shared deadline
    // constant would not be caught by this assertion; add it here when one is
    // introduced.
    expect(CLOUD_API_FETCH_MAX_TIMEOUT_MS).toBe(LONG_RUNNING_API_TIMEOUT_MS);
  });

  it("omits the deadline when there is none the bridge can accept", async () => {
    // A non-positive/non-finite value would be rejected outright by the main
    // process's strict schema — failing the WHOLE request rather than just
    // losing the override. Send nothing and let the bridge apply its default.
    for (const timeoutMs of [
      undefined,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const { doFetch, cloudApiFetch } = setup();
      await doFetch(bridgeUrl("/agent-sessions"), { timeoutMs });
      expect(Object.hasOwn(cloudApiFetch.mock.calls[0][0], "timeoutMs")).toBe(
        false
      );
    }
  });

  it("sends the deadline opt-out as the longest bound the bridge can express", async () => {
    // `timeoutMs: null` is the client's explicit "wait indefinitely". Omitting
    // it would hand the call site that asked to wait LONGEST the bridge's
    // SHORTEST bound (its 60s default) — the inversion this case exists to
    // prevent.
    const { doFetch, cloudApiFetch } = setup();
    await doFetch(bridgeUrl("/agent-sessions"), { timeoutMs: null });
    expect(cloudApiFetch).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: CLOUD_API_FETCH_MAX_TIMEOUT_MS })
    );
  });

  it("rounds a fractional deadline up to whole milliseconds", async () => {
    // `AbortSignal.timeout()` in the main process throws `ERR_OUT_OF_RANGE` on
    // a fractional delay, which would fail the request before it left the
    // machine. Up, not down, so the bridge's deadline never lands inside the
    // client's.
    const { doFetch, cloudApiFetch } = setup();
    await doFetch(bridgeUrl("/agent-sessions"), { timeoutMs: 1500.5 });
    expect(cloudApiFetch).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1501 })
    );
  });

  it("fails like an unreachable network when the bridge is absent", async () => {
    const adapter = createDesktopCloudApiAdapter({} as unknown as DesktopApi);
    const doFetch = adapter.fetch;
    if (!doFetch) {
      throw new Error("adapter must provide a fetch implementation");
    }
    await expect(doFetch(bridgeUrl("/agent-sessions"))).rejects.toThrow(
      TypeError
    );
  });
});
