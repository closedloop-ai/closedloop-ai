import { log } from "@repo/observability/log";
import {
  buildRequestCompletedContractAttributes,
  REQUEST_COMPLETED_CONTRACT_EVENT_NAME,
} from "@repo/observability/telemetry/request-completed";
import { resolveSpanErrorType } from "@repo/observability/telemetry/span-error-cause";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  closingBody,
  erroringBody,
  streamRequest,
} from "@/__tests__/utils/bounded-body.test-helpers";
import {
  badRequestResponse,
  DEFAULT_REQUEST_MAX_BYTES,
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  logRequestCompleted,
  notFoundResponse,
  parseBody,
  parseQueryParams,
  parseSequenceCursor,
  REQUEST_BODY_OVER_CAP_EVENT,
  requestBodyTruncationError,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseSequenceCursor", () => {
  it("returns undefined when the raw value is absent", () => {
    expect(parseSequenceCursor(null)).toBeUndefined();
  });

  it("parses a non-negative integer cursor", () => {
    expect(parseSequenceCursor("0")).toBe(0);
    expect(parseSequenceCursor("42")).toBe(42);
  });

  it("rejects negative, fractional, or non-numeric values", () => {
    expect(parseSequenceCursor("-1")).toBeUndefined();
    expect(parseSequenceCursor("3.5")).toBeUndefined();
    expect(parseSequenceCursor("abc")).toBeUndefined();
  });

  // ISS-11195: the cursor is bound as `::int`, so a value past the int4
  // ceiling raised 22003 and the events route answered 500.
  it("keeps the int4 ceiling and refuses anything past it", () => {
    expect(parseSequenceCursor("2147483647")).toBe(2_147_483_647);
    expect(parseSequenceCursor("2147483648")).toBeUndefined();
    expect(parseSequenceCursor("3000000000")).toBeUndefined();
    expect(parseSequenceCursor("1e21")).toBeUndefined();
  });
});

describe("parseBody", () => {
  const testSchema = z.object({
    name: z.string(),
    age: z.number(),
  });

  it("returns parsed body for valid data", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ name: "Test", age: 25 }),
      headers: { "Content-Type": "application/json" },
    });

    const result = await parseBody(request, testSchema);
    expect(result.body).toEqual({ name: "Test", age: 25 });
    expect(result.errorResponse).toBeNull();
  });

  it("returns errorResponse for invalid schema", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ name: "Test" }), // missing age
      headers: { "Content-Type": "application/json" },
    });

    const result = await parseBody(request, testSchema);
    expect(result.body).toBeNull();
    expect(result.errorResponse).not.toBeNull();

    if (result.errorResponse) {
      expect(result.errorResponse.status).toBe(400);
    }
  });

  it("returns 400 for a complete malformed JSON body", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    const request = new Request("http://localhost", {
      method: "POST",
      body: "not valid json",
      headers: { "Content-Type": "application/json" },
    });

    const result = await parseBody(request, testSchema);
    expect(result.body).toBeNull();
    expect(result.errorResponse).not.toBeNull();

    if (result.errorResponse) {
      const json = await result.errorResponse.json();
      expect(result.errorResponse.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toBe("Invalid JSON body");
    }
    expect(errorLog).toHaveBeenCalledWith("Failed to parse request body:", {
      error: expect.any(SyntaxError),
    });
  });

  it("returns 500 when the request body stream rejects", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    const request = streamRequest(
      "http://localhost",
      erroringBody("stream aborted")
    );

    const result = await parseBody(request, testSchema);

    expect(result.body).toBeNull();
    expect(result.errorResponse?.status).toBe(500);
    await expect(result.errorResponse?.json()).resolves.toEqual({
      success: false,
      error: "Failed to read request body",
    });
    expect(errorLog).toHaveBeenCalledWith("Failed to read request body", {
      error: expect.objectContaining({ message: "stream aborted" }),
    });
  });

  it("returns 500 for an aborted body shorter than Content-Length", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    const abortController = new AbortController();
    const partialBody = '{"name":"Interrupted"';
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(partialBody));
        controller.close();
      },
    });
    const request = new Request("http://localhost", {
      method: "POST",
      body,
      headers: {
        "Content-Length": String(
          new TextEncoder().encode(partialBody).length + 1
        ),
        "Content-Type": "application/json",
      },
      signal: abortController.signal,
      duplex: "half",
    } as RequestInit);
    abortController.abort();

    const result = await parseBody(request, testSchema);

    expect(result.body).toBeNull();
    expect(result.errorResponse?.status).toBe(500);
    expect(errorLog).toHaveBeenCalledWith("Failed to read request body", {
      error: expect.objectContaining({ name: "AbortError" }),
    });
  });

  it("returns 500 for a cleanly closed body shorter than Content-Length", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    const partialBody = '{"name":"Interrupted"';
    const request = streamRequest(
      "http://localhost",
      closingBody(partialBody),
      {
        "Content-Length": String(
          new TextEncoder().encode(partialBody).length + 1
        ),
      }
    );

    const result = await parseBody(request, testSchema);

    expect(result.body).toBeNull();
    expect(result.errorResponse?.status).toBe(500);
    await expect(result.errorResponse?.json()).resolves.toEqual({
      success: false,
      error: "Failed to read request body",
    });
    expect(errorLog).toHaveBeenCalledWith("Failed to read request body", {
      error: expect.objectContaining({
        message: "Request body ended before its declared Content-Length",
      }),
    });
  });

  it("returns 500 for a coded body short of its Content-Length", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    const partialBody = '{"name":"Interrupted"';
    // Bounded readers consume request.body UNDECODED, so Content-Length and
    // bytesRead count the same wire bytes under a content coding too.
    const request = streamRequest(
      "http://localhost",
      closingBody(partialBody),
      {
        "Content-Encoding": "gzip",
        "Content-Length": String(
          new TextEncoder().encode(partialBody).length + 1
        ),
      }
    );

    const result = await parseBody(request, testSchema);

    expect(result.body).toBeNull();
    expect(result.errorResponse?.status).toBe(500);
    expect(errorLog).toHaveBeenCalledWith("Failed to read request body", {
      error: expect.objectContaining({ name: "RequestBodyTruncatedError" }),
    });
  });

  it("names the truncation error so span attribution can filter it", () => {
    const partialBody = '{"name":"Interrupted"';
    const request = streamRequest(
      "http://localhost",
      closingBody(partialBody),
      {
        "Content-Length": String(
          new TextEncoder().encode(partialBody).length + 1
        ),
      }
    );

    // errorResponse records a cause for every 5xx. A bare Error would land in
    // the RCA population as an unfilterable "Error", which is what puts a
    // client disconnect beside real route faults.
    expect(resolveSpanErrorType(requestBodyTruncationError(request, 1))).toBe(
      "RequestBodyTruncatedError"
    );
  });

  it("reports no truncation for a body that met its Content-Length", () => {
    const body = '{"name":"Whole","age":1}';
    const bytes = new TextEncoder().encode(body).length;
    const request = streamRequest("http://localhost", closingBody(body), {
      "Content-Length": String(bytes),
    });

    expect(requestBodyTruncationError(request, bytes)).toBeNull();
  });

  it("returns 400 for complete BOM-prefixed malformed JSON after signal abort", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    const abortController = new AbortController();
    const malformedBody = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("not valid json"),
    ]);
    const request = new Request("http://localhost", {
      method: "POST",
      body: malformedBody,
      headers: {
        "Content-Length": String(malformedBody.byteLength),
        "Content-Type": "application/json",
      },
      signal: abortController.signal,
    });
    abortController.abort();

    const result = await parseBody(request, testSchema);

    expect(result.body).toBeNull();
    expect(result.errorResponse?.status).toBe(400);
    expect(errorLog).toHaveBeenCalledWith("Failed to parse request body:", {
      error: expect.any(SyntaxError),
    });
  });

  it("returns 413 when over-cap stream cancellation rejects", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });

    const result = await parseBody(
      streamRequest("http://localhost", body),
      testSchema,
      { maxBytes: 8 }
    );

    expect(result.body).toBeNull();
    expect(result.errorResponse?.status).toBe(413);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to cancel over-cap request body stream",
      { error: expect.objectContaining({ message: "cancel failed" }) }
    );
  });

  it("returns 400 when a validator transform throws", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => {});
    const throwingSchema = z.string().transform(() => {
      throw new Error("transform failed");
    });
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify("value"),
      headers: { "Content-Type": "application/json" },
    });

    const result = await parseBody(request, throwingSchema);

    expect(result.body).toBeNull();
    expect(result.errorResponse?.status).toBe(400);
    expect(errorLog).toHaveBeenCalledWith("Failed to parse request body:", {
      error: expect.objectContaining({ message: "transform failed" }),
    });
  });

  it("returns errorResponse when body exceeds maxBytes", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ name: "Oversized", age: 25 }),
      headers: { "Content-Type": "application/json" },
    });

    const result = await parseBody(request, testSchema, { maxBytes: 8 });
    expect(result.body).toBeNull();
    expect(result.errorResponse).not.toBeNull();

    if (result.errorResponse) {
      const json = await result.errorResponse.json();
      expect(result.errorResponse.status).toBe(413);
      expect(json.success).toBe(false);
      expect(json.error).toBe("Request body too large");
    }
  });

  // A route that must react to one specific field's failure reads `issues`
  // instead of re-parsing the body against a second schema that could drift
  // from the first (ISS-6966). That only works if the issues are actually
  // there on validation failure — and absent on the failures that never
  // produced any, so a caller cannot mistake "unparseable" for "field wrong".
  it("exposes the zod issues behind a validation failure", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ name: "Test" }),
      headers: { "Content-Type": "application/json" },
    });

    const result = await parseBody(request, testSchema);

    expect(result.issues?.map((issue) => issue.path)).toEqual([["age"]]);
    expect(result.issues?.[0]?.code).toBe("invalid_type");
  });

  it("omits issues for malformed JSON, which never reached validation", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "not valid json",
      headers: { "Content-Type": "application/json" },
    });

    const result = await parseBody(request, testSchema);

    expect(result.errorResponse).not.toBeNull();
    expect(result.issues).toBeUndefined();
  });

  it("omits issues for an over-cap body, which never reached validation", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ name: "Oversized", age: 25 }),
      headers: { "Content-Type": "application/json" },
    });

    const result = await parseBody(request, testSchema, { maxBytes: 8 });

    expect(result.errorResponse).not.toBeNull();
    expect(result.issues).toBeUndefined();
  });

  it("omits issues on success", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ name: "Test", age: 25 }),
      headers: { "Content-Type": "application/json" },
    });

    const result = await parseBody(request, testSchema);

    expect(result.errorResponse).toBeNull();
    expect(result.issues).toBeUndefined();
  });
});

describe("parseBody default bound", () => {
  const testSchema = z.object({ name: z.string(), age: z.number() });

  // Written independently of the constant on purpose: every test below sizes
  // its fixture FROM `DEFAULT_REQUEST_MAX_BYTES`, so without this a change to
  // the value itself would move both the bound and its own proof together.
  it("pins the default cap at 4 MiB", () => {
    expect(DEFAULT_REQUEST_MAX_BYTES).toBe(4_194_304);
  });

  function bodyOfExactly(bytes: number): string {
    const envelope = JSON.stringify({ name: "", age: 25 });
    return JSON.stringify({
      name: "a".repeat(bytes - envelope.length),
      age: 25,
    });
  }

  function postRequest(body: string): Request {
    return new Request("http://localhost/documents", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ISS-7565 acceptance: the bound must hold for a call site that opts into
  // NOTHING — that is what makes the next route added bounded by construction.
  it("rejects an over-cap body at a call site that passes no options", async () => {
    const result = await parseBody(
      postRequest(bodyOfExactly(DEFAULT_REQUEST_MAX_BYTES + 1)),
      testSchema
    );

    expect(result.body).toBeNull();
    expect(result.errorResponse?.status).toBe(413);
    await expect(result.errorResponse?.json()).resolves.toEqual({
      success: false,
      error: "Request body too large",
    });
  });

  // The other arm: without it, a bound that rejected EVERY body would satisfy
  // the test above.
  it("accepts a body sitting exactly on the default cap", async () => {
    const result = await parseBody(
      postRequest(bodyOfExactly(DEFAULT_REQUEST_MAX_BYTES)),
      testSchema
    );

    expect(result.errorResponse).toBeNull();
    expect(result.body?.age).toBe(25);
  });

  it("reports the cap that refused the body", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {
      // silence
    });

    await parseBody(
      postRequest(bodyOfExactly(DEFAULT_REQUEST_MAX_BYTES + 1)),
      testSchema
    );

    expect(warn).toHaveBeenCalledWith(REQUEST_BODY_OVER_CAP_EVENT, {
      maxBytes: DEFAULT_REQUEST_MAX_BYTES,
      method: "POST",
      path: "/documents",
    });
  });
});

describe("parseQueryParams", () => {
  it("preserves repeated query parameters as arrays", () => {
    const url = new URL("http://localhost?targetIds=a&targetIds=b&mode=direct");
    const result = parseQueryParams(
      { nextUrl: { searchParams: url.searchParams } },
      z.object({
        targetIds: z.array(z.string()),
        mode: z.string(),
      })
    );

    expect(result.errorResponse).toBeNull();
    expect(result.params).toEqual({
      targetIds: ["a", "b"],
      mode: "direct",
    });
  });
});

describe("logRequestCompleted", () => {
  // ISS-5039: exactly ONE log line per request. Every deployed log call is
  // billed twice in Datadog (Vercel Log Drain + agentless intake), so a second
  // line here is two more billed events per request. The contract attributes
  // must ride on the same line, not a `request_completed.contract` sibling.
  it("emits one log line carrying both the snake_case and contract fields", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    vi.spyOn(globalThis.performance, "now").mockReturnValue(150);

    logRequestCompleted(
      new Request("https://api.test/loops?secret=redacted", {
        method: "POST",
      }),
      125,
      201,
      undefined,
      undefined
    );

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("request_completed", {
      ...buildRequestCompletedContractAttributes({
        requestUrl: "https://api.test/loops?secret=redacted",
        method: "POST",
        statusCode: 201,
        durationMs: 25,
      }),
      path: "/loops",
      method: "POST",
      status_code: 201,
      duration_ms: 25,
    });
    expect(info).not.toHaveBeenCalledWith(
      REQUEST_COMPLETED_CONTRACT_EVENT_NAME,
      expect.anything()
    );
  });
});

describe("successResponse", () => {
  it("returns 200 status with success data", async () => {
    const response = successResponse({ id: "123", name: "Test" });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ id: "123", name: "Test" });
  });
});

describe("errorResponse", () => {
  it("returns 500 status with error message", async () => {
    const response = errorResponse(
      "Something failed",
      new Error("Internal error")
    );
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Something failed");
  });

  it("accepts custom status code", () => {
    const response = errorResponse(
      "Bad request",
      new Error("Validation error"),
      400
    );
    expect(response.status).toBe(400);
  });
});

describe("badRequestResponse", () => {
  it("returns 400 status", async () => {
    const response = badRequestResponse("Invalid input");
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Invalid input");
  });
});

describe("notFoundResponse", () => {
  it("returns 404 status with entity name", async () => {
    const response = notFoundResponse("User");
    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("User not found");
  });
});

describe("unauthorizedResponse", () => {
  it("returns 401 status", async () => {
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Unauthorized");
  });
});

describe("forbiddenResponse", () => {
  it("returns 403 status", async () => {
    const response = forbiddenResponse();
    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Forbidden");
  });
});

describe("deleteResponse", () => {
  it("returns success with deleted flag", async () => {
    const response = deleteResponse();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ deleted: true });
  });
});
