import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  jsonResponse,
  parseRequestUrl,
  readBody,
  respondInternalError,
} from "../http-io.js";

const logMocks = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@repo/observability/log", () => ({ log: logMocks }));

const ONE_MB = 1_048_576;

type MockRequest = EventEmitter & {
  destroy: ReturnType<typeof vi.fn>;
};

function makeRequest(): MockRequest {
  return Object.assign(new EventEmitter(), { destroy: vi.fn() });
}

function makeResponse(): ServerResponse & {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse & {
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

describe("readBody", () => {
  it("concatenates chunks into a utf-8 string", async () => {
    const req = makeRequest();
    const body = readBody(req as unknown as IncomingMessage);

    req.emit("data", Buffer.from('{"a":'));
    req.emit("data", Buffer.from('"café"}'));
    req.emit("end");

    await expect(body).resolves.toBe('{"a":"café"}');
  });

  it("rejects and destroys the request once the body passes 1 MB", async () => {
    const req = makeRequest();
    const body = readBody(req as unknown as IncomingMessage);

    req.emit("data", Buffer.alloc(ONE_MB + 1));

    await expect(body).rejects.toThrow("Request body exceeds 1 MB limit");
    expect(req.destroy).toHaveBeenCalled();
  });

  it("accepts a body exactly at the 1 MB limit", async () => {
    const req = makeRequest();
    const body = readBody(req as unknown as IncomingMessage);

    req.emit("data", Buffer.alloc(ONE_MB, 0x61));
    req.emit("end");

    await expect(body).resolves.toHaveLength(ONE_MB);
    expect(req.destroy).not.toHaveBeenCalled();
  });

  it("enforces the limit across accumulated chunks, not per chunk", async () => {
    const req = makeRequest();
    const body = readBody(req as unknown as IncomingMessage);

    // Each chunk is well under the cap; only the running total crosses it.
    req.emit("data", Buffer.alloc(ONE_MB - 1));
    req.emit("data", Buffer.alloc(2));

    await expect(body).rejects.toThrow("Request body exceeds 1 MB limit");
    expect(req.destroy).toHaveBeenCalled();
  });

  it("rejects when the request stream errors", async () => {
    const req = makeRequest();
    const body = readBody(req as unknown as IncomingMessage);

    req.emit("error", new Error("ECONNRESET"));

    await expect(body).rejects.toThrow("ECONNRESET");
  });
});

describe("jsonResponse", () => {
  it("writes the status, JSON content type, and serialized body", () => {
    const res = makeResponse();

    jsonResponse(res, 404, { error: "Not found" });

    expect(res.writeHead).toHaveBeenCalledWith(404, {
      "Content-Type": "application/json",
    });
    expect(res.end).toHaveBeenCalledWith('{"error":"Not found"}');
  });
});

describe("parseRequestUrl", () => {
  it("resolves the path and query against the Host authority", () => {
    const url = parseRequestUrl({
      url: "/dispatch?targetId=abc",
      headers: { host: "relay.internal:3020" },
    });

    expect(url?.pathname).toBe("/dispatch");
    expect(url?.host).toBe("relay.internal:3020");
    expect(url?.searchParams.get("targetId")).toBe("abc");
  });

  it("falls back to localhost when the Host header is absent", () => {
    const url = parseRequestUrl({ url: "/health", headers: {} });

    expect(url?.host).toBe("localhost");
    expect(url?.pathname).toBe("/health");
  });

  it("falls back to / when the request carries no url", () => {
    const url = parseRequestUrl({
      url: undefined,
      headers: { host: "relay.internal" },
    });

    expect(url?.pathname).toBe("/");
  });

  it("accepts a bracketed IPv6 literal with a port", () => {
    const url = parseRequestUrl({
      url: "/health",
      headers: { host: "[::1]:3020" },
    });

    expect(url?.hostname).toBe("[::1]");
    expect(url?.port).toBe("3020");
  });

  it.each([
    ["unclosed IPv6 bracket", "["],
    ["space inside the authority", "a b"],
    ["non-numeric port", "host:abc"],
    ["bare at-sign", "@"],
  ])("returns null rather than throwing — %s", (_label, host) => {
    expect(parseRequestUrl({ url: "/health", headers: { host } })).toBeNull();
  });

  it("treats an empty Host header as malformed, not absent", () => {
    // The handler's `?? "localhost"` default is nullish, not falsy: "" reaches
    // the constructor as the base "http://" and throws.
    expect(
      parseRequestUrl({ url: "/health", headers: { host: "" } })
    ).toBeNull();
  });
});

type MockErrorResponse = ServerResponse & {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function makeErrorResponse(
  overrides: Partial<{
    headersSent: boolean;
    writableEnded: boolean;
    destroyed: boolean;
    socket: { destroyed: boolean } | null;
  }> = {}
): MockErrorResponse {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    socket: { destroyed: false },
    ...overrides,
  } as unknown as MockErrorResponse;
}

describe("respondInternalError", () => {
  beforeEach(() => {
    logMocks.error.mockClear();
  });

  it("logs and answers 500 while the response is still open", () => {
    const res = makeErrorResponse();
    const error = new Error("boom");

    respondInternalError(res, "Dispatch handler error", error);

    expect(logMocks.error).toHaveBeenCalledWith("Dispatch handler error", {
      error,
    });
    expect(res.writeHead).toHaveBeenCalledWith(500, {
      "Content-Type": "application/json",
    });
    expect(res.end).toHaveBeenCalledWith('{"error":"Internal server error"}');
  });

  it.each([
    ["the socket is gone", { socket: null }],
    ["the socket is destroyed", { socket: { destroyed: true } }],
    ["headers were already sent", { headersSent: true }],
    ["the response already ended", { writableEnded: true }],
  ])("still logs but writes nothing when %s", (_label, overrides) => {
    const res = makeErrorResponse(overrides);
    const error = new Error("boom");

    respondInternalError(res, "Dispatch handler error", error);

    // The log is the signal that survives a torn-down socket, so it stays
    // unconditional even where the write is skipped.
    expect(logMocks.error).toHaveBeenCalledWith("Dispatch handler error", {
      error,
    });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});
