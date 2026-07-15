/**
 * Unit tests for apps/desktop/src/server/operations/loop-http.ts
 *
 * Covers:
 *   - postLoopEvent: correct headers (Authorization, Content-Type, x-loop-event-nonce)
 *   - postLoopEvent: timestamp auto-injection when absent
 *   - postLoopEvent: null token short-circuits without sending a request
 *   - postLoopEvent: structured kind/status discriminator on HTTP and network errors
 *   - postLoopEvent: network error handling
 *   - uploadArtifacts: correct headers (no x-loop-event-nonce)
 *   - uploadArtifacts: null token short-circuits without sending a request
 *   - uploadArtifacts: HTTP error response handling
 *   - postLoopEventBounded: AbortController-based timeout abort
 *   - gatewayLog entries for success, failure, and network error paths
 *   - postLoopHeartbeat: X-Session-Token header presence/absence (AC-005)
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { gatewayLog } from "../src/main/gateway-logger.js";
import {
  getCloudLoopStatus,
  postLoopEvent,
  postLoopEventBounded,
  postLoopHeartbeat,
  uploadArtifacts,
} from "../src/server/operations/loop-http.js";

// ---------------------------------------------------------------------------
// Shared mock infrastructure
// ---------------------------------------------------------------------------

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | null;
};

type FetchStubOptions = {
  status?: number;
  responseBody?: string;
  /** If true, the fetch stub will never resolve (simulates a hanging server). */
  hang?: boolean;
};

const originalFetch = globalThis.fetch;

let capturedRequests: CapturedRequest[] = [];
let gatewayLogEntries: Array<{ level: string; tag: string; message: string }> =
  [];

// Saved originals restored in afterEach — stored here so installGatewayLogSpy
// and restoreGatewayLog share the same references without relying on the
// fragile Object.getPrototypeOf().method.bind() pattern (which breaks if the
// method is already an overridden instance property rather than a prototype
// method at the time of restore).
let savedGatewayInfo: typeof gatewayLog.info;
let savedGatewayWarn: typeof gatewayLog.warn;
let savedGatewayError: typeof gatewayLog.error;

// ---------------------------------------------------------------------------
// Fetch stub
//
// We replace globalThis.fetch rather than patching the module import because
// loop-http.ts calls the bare global `fetch` directly.  A module-level import
// replacement would require a loader hook and adds significant complexity; a
// global stub is simpler and correctly intercepts all call sites inside the
// module under test.
// ---------------------------------------------------------------------------

function installFetchStub(options: FetchStubOptions = {}): void {
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    if (options.hang) {
      // Never resolve — caller must abort via AbortSignal
      await new Promise<never>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }
        // If no signal, hang forever (test should have a signal)
      });
    }

    const url = String(input);
    const headersObj: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      const h = new Headers(rawHeaders);
      h.forEach((value, key) => {
        headersObj[key] = value;
      });
    }
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    capturedRequests.push({
      url,
      method: init?.method ?? "GET",
      headers: headersObj,
      body,
      signal: init?.signal ?? null,
    });
    const status = options.status ?? 200;
    const responseText = options.responseBody ?? "{}";
    return new Response(responseText, { status });
  }) as typeof fetch;
}

function installGatewayLogSpy(): void {
  gatewayLog.info = (tag: string, message: string) => {
    gatewayLogEntries.push({ level: "info", tag, message });
    savedGatewayInfo.call(gatewayLog, tag, message);
  };
  gatewayLog.warn = (tag: string, message: string) => {
    gatewayLogEntries.push({ level: "warn", tag, message });
    savedGatewayWarn.call(gatewayLog, tag, message);
  };
  gatewayLog.error = (tag: string, message: string) => {
    gatewayLogEntries.push({ level: "error", tag, message });
    savedGatewayError.call(gatewayLog, tag, message);
  };
}

function restoreGatewayLog(): void {
  gatewayLog.info = savedGatewayInfo;
  gatewayLog.warn = savedGatewayWarn;
  gatewayLog.error = savedGatewayError;
}

beforeEach(() => {
  capturedRequests = [];
  gatewayLogEntries = [];
  // Save originals before installing the spy so restoreGatewayLog can put
  // back exactly what was there at the start of each test (not a stale
  // prototype-derived reference).
  savedGatewayInfo = gatewayLog.info.bind(gatewayLog);
  savedGatewayWarn = gatewayLog.warn.bind(gatewayLog);
  savedGatewayError = gatewayLog.error.bind(gatewayLog);
  installGatewayLogSpy();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreGatewayLog();
});

// ---------------------------------------------------------------------------
// postLoopEvent — headers
// ---------------------------------------------------------------------------

describe("postLoopEvent headers", () => {
  test("includes Authorization, Content-Type, and x-loop-event-nonce", async () => {
    installFetchStub({ status: 200 });
    const result = await postLoopEvent(
      "https://api.example.com",
      "loop-abc",
      () => "my-token",
      { type: "started" }
    );

    assert.equal(result.success, true);
    assert.equal(capturedRequests.length, 1);
    const req = capturedRequests[0];
    assert.ok(req, "Expected at least one captured request");
    assert.equal(req.headers.authorization, "Bearer my-token");
    assert.equal(req.headers["content-type"], "application/json");
    assert.ok(
      typeof req.headers["x-loop-event-nonce"] === "string" &&
        req.headers["x-loop-event-nonce"].length > 0,
      `Expected non-empty x-loop-event-nonce, got: ${JSON.stringify(req.headers["x-loop-event-nonce"])}`
    );
  });

  test("generates a unique nonce on each call", async () => {
    installFetchStub({ status: 200 });
    await postLoopEvent(
      "https://api.example.com",
      "loop-abc",
      () => "my-token",
      { type: "output" }
    );
    await postLoopEvent(
      "https://api.example.com",
      "loop-abc",
      () => "my-token",
      { type: "output" }
    );

    assert.equal(capturedRequests.length, 2);
    const nonce1 = capturedRequests[0]?.headers["x-loop-event-nonce"];
    const nonce2 = capturedRequests[1]?.headers["x-loop-event-nonce"];
    assert.ok(nonce1 && nonce2, "Both nonces must be present");
    assert.notEqual(nonce1, nonce2, "Nonces must be unique per call");
  });

  test("sends POST to the correct URL", async () => {
    installFetchStub({ status: 200 });
    await postLoopEvent("https://api.example.com", "loop-xyz", () => "tok", {
      type: "completed",
    });
    const req = capturedRequests[0];
    assert.ok(req, "Expected a captured request");
    assert.equal(req.url, "https://api.example.com/loops/loop-xyz/events");
    assert.equal(req.method, "POST");
  });
});

// ---------------------------------------------------------------------------
// postLoopEvent — timestamp auto-injection
// ---------------------------------------------------------------------------

describe("postLoopEvent timestamp", () => {
  test("auto-injects timestamp when not provided", async () => {
    installFetchStub({ status: 200 });
    const before = new Date().toISOString();
    await postLoopEvent("https://api.example.com", "loop-ts", () => "tok", {
      type: "started",
    });
    const after = new Date().toISOString();

    const req = capturedRequests[0];
    assert.ok(req, "Expected a captured request");
    const ts = req.body.timestamp;
    assert.ok(
      typeof ts === "string" && /^\d{4}-\d{2}-\d{2}T/.test(ts),
      `Expected ISO timestamp, got: ${JSON.stringify(ts)}`
    );
    assert.ok(
      ts >= before && ts <= after,
      `Injected timestamp ${ts} should be between ${before} and ${after}`
    );
  });

  test("preserves timestamp when already present in eventBody", async () => {
    installFetchStub({ status: 200 });
    const fixedTs = "2024-01-15T10:00:00.000Z";
    await postLoopEvent("https://api.example.com", "loop-ts2", () => "tok", {
      type: "output",
      timestamp: fixedTs,
    });
    const req = capturedRequests[0];
    assert.ok(req, "Expected a captured request");
    assert.equal(req.body.timestamp, fixedTs);
  });
});

// ---------------------------------------------------------------------------
// postLoopEvent — token provider returning null
// ---------------------------------------------------------------------------

describe("postLoopEvent null token", () => {
  test("short-circuits with kind:'auth' and skips fetch when getToken returns null", async () => {
    installFetchStub({ status: 200 });
    const result = await postLoopEvent(
      "https://api.example.com",
      "loop-null-tok",
      () => null,
      { type: "started" }
    );

    assert.equal(result.success, false);
    assert.equal(
      capturedRequests.length,
      0,
      "fetch must not be called when token is null"
    );
    if (result.success) {
      assert.fail("unreachable: result.success was asserted false above");
    }
    assert.equal(result.kind, "auth");
    assert.equal(result.error, "missing_token");
  });
});

// ---------------------------------------------------------------------------
// postLoopEvent — error response handling
// ---------------------------------------------------------------------------

describe("postLoopEvent error responses", () => {
  // postLoopEvent has a single `if (!resp.ok)` branch with no per-status logic;
  // one representative non-2xx case is sufficient. The network-error test below
  // covers the throw branch.
  test("returns kind:'http' with numeric status on non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response("error body", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof fetch;

    const result = await postLoopEvent(
      "https://api.example.com",
      "loop-err",
      () => "tok",
      { type: "started" }
    );
    assert.equal(result.success, false);
    if (result.success) {
      assert.fail("unreachable: result.success was asserted false above");
    }
    assert.equal(result.kind, "http");
    if (result.kind !== "http") {
      assert.fail(`expected kind 'http', got '${result.kind}'`);
    }
    assert.equal(result.status, 500);
    assert.ok(
      result.error.includes("500"),
      `Expected error to include status 500, got: ${JSON.stringify(result.error)}`
    );
  });

  test("returns kind:'network' on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const result = await postLoopEvent(
      "https://api.example.com",
      "loop-net-err",
      () => "tok",
      { type: "started" }
    );
    assert.equal(result.success, false);
    if (result.success) {
      assert.fail("unreachable: result.success was asserted false above");
    }
    assert.equal(result.kind, "network");
    assert.ok(
      result.error.includes("ECONNREFUSED"),
      `Expected error to include ECONNREFUSED, got: ${JSON.stringify(result.error)}`
    );
  });
});

// ---------------------------------------------------------------------------
// uploadArtifacts — correct headers (no nonce)
// ---------------------------------------------------------------------------

describe("uploadArtifacts headers", () => {
  test("includes Authorization and Content-Type but NOT x-loop-event-nonce", async () => {
    installFetchStub({ status: 200 });
    const result = await uploadArtifacts(
      "https://api.example.com",
      "loop-art",
      () => "art-token",
      { files: ["file1.txt"] }
    );

    assert.equal(result.success, true);
    assert.equal(capturedRequests.length, 1);
    const req = capturedRequests[0];
    assert.ok(req, "Expected a captured request");
    assert.equal(req.headers.authorization, "Bearer art-token");
    assert.equal(req.headers["content-type"], "application/json");
    assert.ok(
      !("x-loop-event-nonce" in req.headers),
      "uploadArtifacts must NOT include x-loop-event-nonce"
    );
  });

  test("sends POST to the correct upload-artifacts URL", async () => {
    installFetchStub({ status: 200 });
    await uploadArtifacts("https://api.example.com", "loop-art2", () => "tok", {
      files: [],
    });
    const req = capturedRequests[0];
    assert.ok(req, "Expected a captured request");
    assert.equal(
      req.url,
      "https://api.example.com/loops/loop-art2/upload-artifacts"
    );
    assert.equal(req.method, "POST");
  });

  test("short-circuits with kind:'auth' and skips fetch when getToken returns null", async () => {
    installFetchStub({ status: 200 });
    const result = await uploadArtifacts(
      "https://api.example.com",
      "loop-art-null",
      () => null,
      {}
    );
    assert.equal(result.success, false);
    assert.equal(
      capturedRequests.length,
      0,
      "fetch must not be called when token is null"
    );
    if (result.success) {
      assert.fail("unreachable: result.success was asserted false above");
    }
    assert.equal(result.kind, "auth");
    assert.equal(result.error, "missing_token");
  });

  test("sends exactly the input body as the request body", async () => {
    installFetchStub({ status: 200 });
    const inputBody = {
      files: ["output.txt", "trace.log"],
      metadata: { run: 42 },
    };
    await uploadArtifacts(
      "https://api.example.com",
      "loop-art-body",
      () => "tok",
      inputBody
    );
    const req = capturedRequests[0];
    assert.ok(req, "Expected a captured request");
    assert.deepEqual(
      req.body,
      inputBody,
      `Expected req.body to equal the input body, got: ${JSON.stringify(req.body)}`
    );
  });
});

// ---------------------------------------------------------------------------
// uploadArtifacts — error response handling
// ---------------------------------------------------------------------------

describe("uploadArtifacts error responses", () => {
  test("returns success:false with HTTP error message on non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response("upload failed", {
        status: 422,
        statusText: "Unprocessable Entity",
      })) as typeof fetch;

    const result = await uploadArtifacts(
      "https://api.example.com",
      "loop-art-err",
      () => "tok",
      { files: ["a.txt"] }
    );
    assert.equal(result.success, false);
    assert.ok(
      typeof result.error === "string" && result.error.includes("422"),
      `Expected error to include 422, got: ${JSON.stringify(result.error)}`
    );
  });

  test("returns success:false on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network failure");
    }) as typeof fetch;

    const result = await uploadArtifacts(
      "https://api.example.com",
      "loop-art-net",
      () => "tok",
      {}
    );
    assert.equal(result.success, false);
    assert.ok(
      typeof result.error === "string" &&
        result.error.includes("network failure"),
      `Expected error to include 'network failure', got: ${JSON.stringify(result.error)}`
    );
  });
});

// ---------------------------------------------------------------------------
// postLoopEventBounded — bounded timeout abort
// ---------------------------------------------------------------------------

describe("postLoopEventBounded timeout", () => {
  test("hang triggers timeout and aborts fetch", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      await new Promise<never>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }
      });
    }) as typeof fetch;

    const timeoutMs = 100;
    const result = await postLoopEventBounded(
      "https://api.example.com",
      "loop-bounded",
      () => "tok",
      { type: "started" },
      timeoutMs
    );

    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "timeout",
      `Expected result.error to be 'timeout', got: ${JSON.stringify(result.error)}`
    );
    assert.ok(
      capturedSignal !== undefined,
      "Expected AbortSignal to be passed to fetch"
    );
    assert.ok(
      capturedSignal.aborted,
      "Expected AbortSignal to be aborted after timeout"
    );
  });

  test("returns success:true when server responds within timeout", async () => {
    installFetchStub({ status: 200 });
    const result = await postLoopEventBounded(
      "https://api.example.com",
      "loop-bounded-ok",
      () => "tok",
      { type: "started" },
      1000
    );
    assert.equal(result.success, true);
  });

  test("aborts fetch via AbortSignal on timeout", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      await new Promise<never>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }
      });
    }) as typeof fetch;

    const timeoutMs = 80;
    await postLoopEventBounded(
      "https://api.example.com",
      "loop-abort",
      () => "tok",
      { type: "started" },
      timeoutMs
    );

    assert.ok(
      capturedSignal !== undefined,
      "Expected AbortSignal to be passed to fetch"
    );
    assert.ok(
      capturedSignal.aborted,
      "Expected AbortSignal to be aborted after timeout"
    );
  });
});

// ---------------------------------------------------------------------------
// Logging output verification
// ---------------------------------------------------------------------------

describe("logging output", () => {
  test("postLoopEvent success: emits info log to gatewayLog", async () => {
    installFetchStub({ status: 200 });
    await postLoopEvent("https://api.example.com", "loop-log-ok", () => "tok", {
      type: "started",
    });

    const infoEntries = gatewayLogEntries.filter(
      (e) => e.level === "info" && e.tag === "loop-event"
    );
    assert.ok(
      infoEntries.length > 0,
      "Expected at least one info log entry with tag 'loop-event'"
    );
    const successEntry = infoEntries.find((e) =>
      e.message.includes("loop-log-ok")
    );
    assert.ok(
      successEntry !== undefined,
      `Expected a 'loop-event' info log referencing loopId, found: ${JSON.stringify(infoEntries)}`
    );
  });

  test("postLoopEvent HTTP error: emits error log to gatewayLog", async () => {
    globalThis.fetch = (async () =>
      new Response("bad", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof fetch;

    await postLoopEvent(
      "https://api.example.com",
      "loop-log-err",
      () => "tok",
      { type: "started" }
    );

    const errorEntries = gatewayLogEntries.filter(
      (e) => e.level === "error" && e.tag === "loop-event"
    );
    assert.ok(
      errorEntries.length > 0,
      "Expected at least one error log entry with tag 'loop-event' on HTTP failure"
    );
    const errEntry = errorEntries.find(
      (e) => e.message.includes("500") || e.message.includes("failed")
    );
    assert.ok(
      errEntry !== undefined,
      `Expected an error log mentioning the failure, found: ${JSON.stringify(errorEntries)}`
    );
  });

  test("postLoopEvent network error: emits error log to gatewayLog", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    await postLoopEvent(
      "https://api.example.com",
      "loop-log-netfail",
      () => "tok",
      { type: "started" }
    );

    const errorEntries = gatewayLogEntries.filter(
      (e) => e.level === "error" && e.tag === "loop-event"
    );
    assert.ok(
      errorEntries.length > 0,
      "Expected at least one error log with tag 'loop-event' on network error"
    );
  });

  test("uploadArtifacts success: emits info log to gatewayLog", async () => {
    installFetchStub({ status: 200 });
    await uploadArtifacts(
      "https://api.example.com",
      "loop-upload-log-ok",
      () => "tok",
      { files: [] }
    );

    const infoEntries = gatewayLogEntries.filter(
      (e) => e.level === "info" && e.tag === "loop-upload"
    );
    assert.ok(
      infoEntries.length > 0,
      "Expected at least one info log entry with tag 'loop-upload'"
    );
  });

  test("uploadArtifacts HTTP error: emits error log to gatewayLog", async () => {
    globalThis.fetch = (async () =>
      new Response("fail", {
        status: 503,
        statusText: "Service Unavailable",
      })) as typeof fetch;

    await uploadArtifacts(
      "https://api.example.com",
      "loop-upload-log-err",
      () => "tok",
      {}
    );

    const errorEntries = gatewayLogEntries.filter(
      (e) => e.level === "error" && e.tag === "loop-upload"
    );
    assert.ok(
      errorEntries.length > 0,
      "Expected at least one error log entry with tag 'loop-upload' on HTTP failure"
    );
  });

  test("uploadArtifacts network error: emits error log to gatewayLog", async () => {
    globalThis.fetch = (async () => {
      throw new Error("upload network error");
    }) as typeof fetch;

    await uploadArtifacts(
      "https://api.example.com",
      "loop-upload-log-netfail",
      () => "tok",
      {}
    );

    const errorEntries = gatewayLogEntries.filter(
      (e) => e.level === "error" && e.tag === "loop-upload"
    );
    assert.ok(
      errorEntries.length > 0,
      "Expected at least one error log with tag 'loop-upload' on network error"
    );
  });
});

// ---------------------------------------------------------------------------
// getCloudLoopStatus
// ---------------------------------------------------------------------------

describe("getCloudLoopStatus", () => {
  test("TIMED_OUT response: returns { kind: 'timed_out' }, GET method, correct URL, correct Authorization", async () => {
    installFetchStub({
      status: 200,
      responseBody: JSON.stringify({ status: "TIMED_OUT" }),
    });

    const result = await getCloudLoopStatus(
      "https://api.example.com",
      "loop-abc",
      () => "my-token"
    );

    assert.deepEqual(result, { kind: "timed_out" });
    assert.equal(capturedRequests.length, 1);
    const req = capturedRequests[0];
    assert.ok(req, "Expected a captured request");
    assert.equal(req.method, "GET");
    assert.equal(req.url, "https://api.example.com/loops/loop-abc");
    assert.equal(req.headers.authorization, "Bearer my-token");
  });

  test("RUNNING response: returns { kind: 'active' }", async () => {
    installFetchStub({
      status: 200,
      responseBody: JSON.stringify({ status: "RUNNING" }),
    });

    const result = await getCloudLoopStatus(
      "https://api.example.com",
      "loop-running",
      () => "my-token"
    );

    assert.deepEqual(result, { kind: "active" });
  });

  test("HTTP 404 response: returns { kind: 'error' }", async () => {
    installFetchStub({
      status: 404,
      responseBody: "Not Found",
    });

    const result = await getCloudLoopStatus(
      "https://api.example.com",
      "loop-404",
      () => "my-token"
    );

    assert.equal(result.kind, "error");
  });

  test("HTTP 500 response: returns { kind: 'error' }", async () => {
    installFetchStub({
      status: 500,
      responseBody: "Internal Server Error",
    });

    const result = await getCloudLoopStatus(
      "https://api.example.com",
      "loop-500",
      () => "my-token"
    );

    assert.equal(result.kind, "error");
  });

  test("HTTP 503 with JSON body containing status field: returns { kind: 'error', message: 'HTTP 503' } (T-2.1, AC-003)", async () => {
    // Regression: a non-2xx response with a valid JSON body like {"status":"RUNNING"}
    // must return { kind: 'error' }, not { kind: 'active' }.
    installFetchStub({
      status: 503,
      responseBody: JSON.stringify({ status: "RUNNING" }),
    });

    const result = await getCloudLoopStatus(
      "https://api.example.com",
      "loop-503-json",
      () => "my-token"
    );

    assert.deepEqual(result, {
      kind: "error",
      message: "HTTP 503",
      status: 503,
    });
  });

  test("fetch throws ECONNREFUSED: returns { kind: 'error' }, message includes ECONNREFUSED", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const result = await getCloudLoopStatus(
      "https://api.example.com",
      "loop-net-err",
      () => "my-token"
    );

    assert.equal(result.kind, "error");
    assert.ok(
      result.kind === "error" && result.message.includes("ECONNREFUSED"),
      `Expected message to include ECONNREFUSED, got: ${JSON.stringify(result)}`
    );
  });

  test("null token: Authorization header is 'Bearer '", async () => {
    installFetchStub({
      status: 200,
      responseBody: JSON.stringify({ status: "RUNNING" }),
    });

    await getCloudLoopStatus(
      "https://api.example.com",
      "loop-null-tok",
      () => null
    );

    const req = capturedRequests[0];
    assert.ok(req, "Expected a captured request");
    // Headers normalization trims trailing whitespace, so 'Bearer ' becomes 'Bearer'
    assert.ok(
      req.headers.authorization === "Bearer" ||
        req.headers.authorization === "Bearer ",
      `Authorization header should be 'Bearer' or 'Bearer ' when token is null, got: ${JSON.stringify(req.headers.authorization)}`
    );
  });

  test("missing status field: returns { kind: 'active' }, emits warn log with tag 'loop-status'", async () => {
    installFetchStub({
      status: 200,
      responseBody: JSON.stringify({ other: "field" }),
    });

    const result = await getCloudLoopStatus(
      "https://api.example.com",
      "loop-no-status",
      () => "my-token"
    );

    assert.deepEqual(result, { kind: "active" });

    const warnEntries = gatewayLogEntries.filter(
      (e) => e.level === "warn" && e.tag === "loop-status"
    );
    assert.ok(
      warnEntries.length > 0,
      `Expected at least one warn log entry with tag 'loop-status', got: ${JSON.stringify(gatewayLogEntries)}`
    );
  });

  test("AbortController timeout: returns { kind: 'error' } when fetch hangs and timeoutMs is 1", async () => {
    installFetchStub({ hang: true });

    const result = await getCloudLoopStatus(
      "https://api.example.com",
      "loop-timeout",
      () => "my-token",
      1
    );

    assert.equal(result.kind, "error");
  });
});

// ---------------------------------------------------------------------------
// postLoopHeartbeat — X-Session-Token header presence/absence (AC-005)
// ---------------------------------------------------------------------------

// PLN-740 T-4.8: X-Session-Token header tests removed.
// The X-Session-Token revival path has been removed in PLN-740 T-4.3.
// X-Session-Token header is no longer sent with heartbeat requests.
describe("postLoopHeartbeat X-Session-Token header", () => {
  test("PLN-740 T-4.3: X-Session-Token header is never sent (revival path removed)", async () => {
    installFetchStub({ status: 200, responseBody: "{}" });

    await postLoopHeartbeat("https://api.example.com", "loop-no-session-hdr", {
      getToken: () => "runner-token",
    });

    assert.equal(capturedRequests.length, 1);
    const req = capturedRequests[0];
    assert.ok(req, "Expected a captured request");
    assert.ok(
      !("x-session-token" in req.headers),
      "X-Session-Token must never be sent (PLN-740 T-4.3)"
    );
    assert.equal(req.headers.authorization, "Bearer runner-token");
  });
});
