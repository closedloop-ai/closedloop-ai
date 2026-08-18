import {
  DEPLOYMENT_ID_HEADER,
  ORG_IDENTITY_HEADER,
} from "@repo/api/src/types/headers";
import { describe, expect, it } from "vitest";
import { addCorsHeaders, getCorsHeaders } from "./cors";

function allowedRequestHeaders(origin: string | null): string[] {
  return getCorsHeaders(origin)
    ["Access-Control-Allow-Headers"].split(",")
    .map((h) => h.trim().toLowerCase());
}

describe("getCorsHeaders", () => {
  it("advertises every custom request header the browser app sends cross-origin", () => {
    // Custom (non-safelisted) headers must be in Access-Control-Allow-Headers
    // or the browser preflight blocks the request before it is sent.
    const allowed = allowedRequestHeaders(null);
    expect(allowed).toContain(ORG_IDENTITY_HEADER.toLowerCase());
    // FEA-1485: the skew-protection pin header is forwarded on app→api fetches.
    expect(allowed).toContain(DEPLOYMENT_ID_HEADER.toLowerCase());
    expect(allowed).toContain("authorization");
    expect(allowed).toContain("content-type");
  });

  it("omits origin-specific headers when there is no origin", () => {
    const headers = getCorsHeaders(null);
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  // ISS-4659: the RUM SDK attaches W3C trace context to app→api requests. These
  // headers are not CORS-safelisted, so if they fall out of the allowlist the
  // browser preflight blocks every instrumented request — a total app outage,
  // not a degraded trace. This test is the guard against that regression.
  it("advertises the W3C trace-context request headers", () => {
    const allowed = allowedRequestHeaders(null);
    expect(allowed).toContain("traceparent");
    expect(allowed).toContain("tracestate");
  });

  it("grants Timing-Allow-Origin to a trusted origin so RUM sees resource timing", () => {
    const trustedOrigin = "http://localhost:3000";
    const headers = getCorsHeaders(trustedOrigin);
    expect(headers["Timing-Allow-Origin"]).toBe(trustedOrigin);
  });

  it("withholds Timing-Allow-Origin from an untrusted origin", () => {
    const headers = getCorsHeaders("https://evil.example.com");
    expect(headers["Timing-Allow-Origin"]).toBeUndefined();
    // Guard the pairing too: timing detail must never outlive the ACAO grant.
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});

describe("addCorsHeaders", () => {
  it("copies the CORS headers onto the response", () => {
    const response = new Response(null);
    addCorsHeaders(response, null);
    expect(
      response.headers.get("Access-Control-Allow-Headers")?.toLowerCase()
    ).toContain(DEPLOYMENT_ID_HEADER.toLowerCase());
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "OPTIONS"
    );
  });
});
