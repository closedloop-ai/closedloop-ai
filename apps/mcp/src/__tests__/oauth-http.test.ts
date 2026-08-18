import { describe, expect, it } from "vitest";
import {
  normalizeOAuthTokenBody,
  OAUTH_NO_STORE_HEADERS,
  redirectWithParams,
  sendJson,
  sendOAuthJson,
} from "../oauth-http.js";
import { asServerResponse, createMockResponse } from "./fixtures/mock-http.js";

describe("sendJson", () => {
  it("writes the status, JSON content type, and serialized body", () => {
    const res = createMockResponse();

    sendJson(asServerResponse(res), 201, { ok: true });

    expect(res.statusCode).toBe(201);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("does not apply the OAuth no-store headers", () => {
    const res = createMockResponse();

    sendJson(asServerResponse(res), 200, {});

    expect(res.headers["Cache-Control"]).toBeUndefined();
  });
});

describe("sendOAuthJson", () => {
  it("always applies the RFC 6749 no-store caching headers", () => {
    const res = createMockResponse();

    sendOAuthJson(asServerResponse(res), 400, { error: "invalid_scope" });

    expect(res.statusCode).toBe(400);
    expect(res.headers["Cache-Control"]).toBe(
      OAUTH_NO_STORE_HEADERS["Cache-Control"]
    );
    expect(res.headers.Pragma).toBe(OAUTH_NO_STORE_HEADERS.Pragma);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_scope" });
  });

  it("keeps the no-store headers when extra headers are supplied", () => {
    const res = createMockResponse();

    sendOAuthJson(
      asServerResponse(res),
      401,
      {},
      { "WWW-Authenticate": "Bearer" }
    );

    expect(res.headers["WWW-Authenticate"]).toBe("Bearer");
    expect(res.headers["Cache-Control"]).toBe(
      OAUTH_NO_STORE_HEADERS["Cache-Control"]
    );
  });
});

describe("redirectWithParams", () => {
  it("redirects with the supplied params appended to the redirect URI", () => {
    const res = createMockResponse();

    redirectWithParams(asServerResponse(res), "https://client.test/cb?a=1", {
      error: "invalid_scope",
      state: "xyz",
    });

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.Location);
    expect(location.searchParams.get("a")).toBe("1");
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(location.searchParams.get("state")).toBe("xyz");
  });

  it("omits undefined params instead of serializing them", () => {
    const res = createMockResponse();

    redirectWithParams(asServerResponse(res), "https://client.test/cb", {
      error: "invalid_scope",
      state: undefined,
    });

    const location = new URL(res.headers.Location);
    expect(location.searchParams.has("state")).toBe(false);
  });
});

describe("normalizeOAuthTokenBody", () => {
  it("returns null for null input", () => {
    expect(normalizeOAuthTokenBody(null)).toBeNull();
  });

  it("returns null for a non-object primitive", () => {
    expect(normalizeOAuthTokenBody(42)).toBeNull();
  });

  it("returns null for an array", () => {
    expect(
      normalizeOAuthTokenBody(["grant_type", "client_credentials"])
    ).toBeNull();
  });

  it("returns an empty map for an object whose values are all non-strings", () => {
    expect(normalizeOAuthTokenBody({ expires_in: 3600, active: true })).toEqual(
      {}
    );
  });

  it("keeps only string-valued entries and drops numeric and boolean values", () => {
    expect(
      normalizeOAuthTokenBody({
        grant_type: "authorization_code",
        code: "abc123",
        expires_in: 3600,
        active: true,
      })
    ).toEqual({ grant_type: "authorization_code", code: "abc123" });
  });

  it("returns an empty map for an empty object", () => {
    expect(normalizeOAuthTokenBody({})).toEqual({});
  });
});
