import { z } from "zod";
import {
  badRequestResponse,
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

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
