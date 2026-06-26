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
