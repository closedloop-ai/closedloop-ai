import { log } from "@repo/observability/log";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyNotFound,
  emptyResponse,
  errorResponse,
  HttpServiceErrorCode,
  httpServiceErrorBodySchema,
  serviceErrorHandler,
} from "../errors";

const FAULT_EVENT = "test.fault";

afterEach(() => {
  vi.restoreAllMocks();
});

function throwingApp(handler: ReturnType<typeof serviceErrorHandler>) {
  const app = new Hono();
  app.onError(handler);
  app.get("/throw", () => {
    throw new Error("boom");
  });
  return app;
}

describe("errorResponse", () => {
  it("answers { code } as uncached JSON when given a code", async () => {
    const app = new Hono();
    app.get("/e", (c) => errorResponse(c, 409, "conflict"));

    const response = await app.request("/e");

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(httpServiceErrorBodySchema.parse(await response.json())).toEqual({
      code: "conflict",
    });
  });

  it.each([
    ["null", null],
    ["absent", undefined],
  ])("answers an empty uncached body when code is %s", async (_label, code) => {
    const app = new Hono();
    app.get("/e", (c) => errorResponse(c, 409, code));

    const response = await app.request("/e");

    expect(response.status).toBe(409);
    expect(response.headers.get("content-length")).toBe("0");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });
});

describe("emptyResponse", () => {
  it("sends no body, with content-length 0 and no-store", async () => {
    const app = new Hono();
    app.get("/e", (c) => emptyResponse(c, 202));

    const response = await app.request("/e");

    expect(response.status).toBe(202);
    expect(response.headers.get("content-length")).toBe("0");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toBeNull();
  });
});

describe("serviceErrorHandler", () => {
  it("logs the fault under its event and answers 500 internal by default", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);

    const response = await throwingApp(
      serviceErrorHandler(FAULT_EVENT)
    ).request("/throw");

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      code: HttpServiceErrorCode.Internal,
    });
    expect(error).toHaveBeenCalledExactlyOnceWith(
      "Internal HTTP request failed",
      { event: FAULT_EVENT, path: "/throw", cause: "Error" }
    );
  });

  it("logs a custom message", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);

    await throwingApp(
      serviceErrorHandler(FAULT_EVENT, { message: "Custom fault" })
    ).request("/throw");

    expect(error).toHaveBeenCalledExactlyOnceWith(
      "Custom fault",
      expect.objectContaining({ event: FAULT_EVENT })
    );
  });

  it("answers an empty 500 when code is null", async () => {
    vi.spyOn(log, "error").mockImplementation(() => undefined);

    const response = await throwingApp(
      serviceErrorHandler(FAULT_EVENT, { code: null })
    ).request("/throw");

    expect(response.status).toBe(500);
    expect(response.headers.get("content-length")).toBe("0");
    expect(await response.text()).toBe("");
  });
});

describe("emptyNotFound", () => {
  it("answers an empty 404, not Hono's text body", async () => {
    const app = new Hono();
    app.notFound(emptyNotFound);

    const response = await app.request("/missing");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-length")).toBe("0");
    expect(await response.text()).toBe("");
  });
});
