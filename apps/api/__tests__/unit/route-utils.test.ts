import { log } from "@repo/observability/log";
import { REQUEST_COMPLETED_CONTRACT_EVENT_NAME } from "@repo/observability/telemetry/request-completed";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  badRequestResponse,
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  logRequestCompleted,
  notFoundResponse,
  parseBody,
  parseQueryParams,
  parseSequenceCursor,
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

  it("returns errorResponse for malformed JSON", async () => {
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
      expect(json.success).toBe(false);
      expect(json.error).toBe("Invalid JSON body");
    }
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
  it("emits the legacy request_completed log and the contract span log", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    vi.spyOn(globalThis.performance, "now").mockReturnValue(150);

    logRequestCompleted(
      new Request("https://api.test/loops?secret=redacted", {
        method: "POST",
      }),
      125,
      201
    );

    expect(info).toHaveBeenCalledWith("request_completed", {
      path: "/loops",
      method: "POST",
      status_code: 201,
      duration_ms: 25,
    });
    expect(info).toHaveBeenCalledWith(
      REQUEST_COMPLETED_CONTRACT_EVENT_NAME,
      expect.any(Object)
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
