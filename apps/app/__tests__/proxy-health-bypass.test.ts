// @vitest-environment node

import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/health/route";
import { config } from "@/proxy";

vi.mock("@repo/auth/proxy", () => ({
  authMiddleware: (handler: unknown) => handler,
}));

const ORIGIN = "http://localhost:3000";

function proxyRunsFor(pathname: string): boolean {
  return unstable_doesMiddlewareMatch({
    config: { matcher: config.matcher },
    url: `${ORIGIN}${pathname}`,
  });
}

describe("ISS-11832 /health health check", () => {
  it("skips the proxy for exactly /health", () => {
    expect(proxyRunsFor("/health")).toBe(false);
  });

  it.each(["/healthz", "/health/extra", "/api/health", "/acme/health"])(
    "still runs the proxy for %s",
    (pathname) => {
      expect(proxyRunsFor(pathname)).toBe(true);
    }
  );

  it("answers 200 with an empty body", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
  });
});
