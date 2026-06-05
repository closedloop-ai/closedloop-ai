import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLocalGatewayOriginAllowed } from "../local-gateway-origins";

describe("local-gateway-origins", () => {
  const env = process.env as Record<string, string | undefined>;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPreviewDomain = process.env.NEXT_PUBLIC_PREVIEW_DOMAIN;

  beforeEach(() => {
    env.NODE_ENV = "production";
    env.NEXT_PUBLIC_PREVIEW_DOMAIN = "preview.localhost";
  });

  afterEach(() => {
    env.NODE_ENV = originalNodeEnv;
    env.NEXT_PUBLIC_PREVIEW_DOMAIN = originalPreviewDomain;
  });

  it("allows exact preview suffix hosts and their subdomains", () => {
    expect(
      isLocalGatewayOriginAllowed("https://preview.localhost")
    ).toBe(true);
    expect(
      isLocalGatewayOriginAllowed("https://app.preview.localhost")
    ).toBe(true);
  });

  it("rejects partial-match preview suffix hosts without a dot boundary", () => {
    expect(
      isLocalGatewayOriginAllowed("https://evilpreview.localhost")
    ).toBe(false);
  });

  it("rejects origin strings that include a path", () => {
    expect(
      isLocalGatewayOriginAllowed("https://preview.localhost/path")
    ).toBe(false);
  });
});
