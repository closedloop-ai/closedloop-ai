import { ARTIFACT_LINK_CONTINUATION_HEADERS } from "@repo/api/src/types/artifact";
import { DOCUMENT_LIST_CONTINUATION_HEADERS } from "@repo/api/src/types/document";
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

  // ISS-6941: `GET /documents` states its pagination continuation in response
  // headers. A response header a cross-origin browser caller may READ has to be
  // named in Access-Control-Expose-Headers — otherwise the browser hands
  // JavaScript only the safelisted ones and `headers.get(...)` returns null with
  // no error, so the metadata would look absent rather than blocked.
  it("exposes the document-list continuation response headers", () => {
    const exposed = getCorsHeaders(null)
      ["Access-Control-Expose-Headers"].split(",")
      .map((header) => header.trim().toLowerCase());

    expect(exposed).toContain(DOCUMENT_LIST_CONTINUATION_HEADERS.Total);
    expect(exposed).toContain(DOCUMENT_LIST_CONTINUATION_HEADERS.HasMore);
    expect(exposed).toContain(DOCUMENT_LIST_CONTINUATION_HEADERS.NextOffset);
  });

  // ISS-10102: same contract for the artifact-link tree. Unexposed, a browser
  // caller reads `null` from `headers.get(...)` with no error — indistinguishable
  // from "this page is complete", which is the exact confusion these exist to end.
  it("exposes the artifact-link continuation response headers", () => {
    const exposed = getCorsHeaders(null)
      ["Access-Control-Expose-Headers"].split(",")
      .map((header) => header.trim().toLowerCase());

    expect(exposed).toContain(ARTIFACT_LINK_CONTINUATION_HEADERS.HasMore);
    expect(exposed).toContain(ARTIFACT_LINK_CONTINUATION_HEADERS.NextCursor);
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

  // ISS-11929: posthog-js sends all three to the cl-api host together, so one
  // missing name fails the preflight for every app→api request. Literals, not
  // the shared constant: these are posthog-js's wire names, not ours.
  it("advertises the PostHog session request headers", () => {
    const allowed = allowedRequestHeaders(null);
    expect(allowed).toContain("x-posthog-session-id");
    expect(allowed).toContain("x-posthog-window-id");
    expect(allowed).toContain("x-posthog-distinct-id");
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
