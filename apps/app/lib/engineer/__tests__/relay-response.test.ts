import { describe, expect, test } from "vitest";
import { parseRelayHttpResponse } from "../relay-response";

describe("parseRelayHttpResponse", () => {
  test("wraps a non-object value as a 200 response with the value as the body", () => {
    const result = parseRelayHttpResponse("plain string body");
    expect(result?.status).toBe(200);
    expect(result?.body).toBe("plain string body");
    expect([...(result?.headers.entries() ?? [])]).toEqual([]);
  });

  test("wraps a null value as a 200 response with a null body", () => {
    const result = parseRelayHttpResponse(null);
    expect(result?.status).toBe(200);
    expect(result?.body).toBeNull();
  });

  test("parses the relay envelope shape ({ status, body })", () => {
    const result = parseRelayHttpResponse({
      status: 404,
      body: { error: "not found" },
    });
    expect(result?.status).toBe(404);
    expect(result?.body).toEqual({ error: "not found" });
  });

  test("parses the Electron gateway envelope shape ({ statusCode, data })", () => {
    const result = parseRelayHttpResponse({
      statusCode: 201,
      success: true,
      data: { id: "abc" },
    });
    expect(result?.status).toBe(201);
    expect(result?.body).toEqual({ id: "abc" });
  });

  test("prefers status/body over statusCode/data when both are present", () => {
    const result = parseRelayHttpResponse({
      status: 200,
      statusCode: 500,
      body: "from body",
      data: "from data",
    });
    expect(result?.status).toBe(200);
    expect(result?.body).toBe("from body");
  });

  test("returns null when neither status nor statusCode is a number", () => {
    const result = parseRelayHttpResponse({ body: { ok: true } });
    expect(result).toBeNull();
  });

  test("returns null when neither body nor data key is present", () => {
    const result = parseRelayHttpResponse({ status: 200 });
    expect(result).toBeNull();
  });

  test("treats an explicit undefined body as a missing envelope and returns null", () => {
    const result = parseRelayHttpResponse({ status: 200, body: undefined });
    expect(result).toBeNull();
  });

  test("builds headers from a valid headers object on the envelope", () => {
    const result = parseRelayHttpResponse({
      status: 200,
      body: "ok",
      headers: { "content-type": "application/json" },
    });
    expect(result?.headers.get("content-type")).toBe("application/json");
  });

  test("falls back to empty headers when the headers field is not an object", () => {
    const result = parseRelayHttpResponse({
      status: 200,
      body: "ok",
      headers: "not-an-object",
    });
    expect([...(result?.headers.entries() ?? [])]).toEqual([]);
  });

  test("falls back to empty headers when the headers field is null", () => {
    const result = parseRelayHttpResponse({
      status: 200,
      body: "ok",
      headers: null,
    });
    expect([...(result?.headers.entries() ?? [])]).toEqual([]);
  });
});
