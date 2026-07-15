import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveApiOrigin } from "@/lib/api-origin";

const mockEnv = vi.hoisted(
  (): { NEXT_PUBLIC_API_URL: string; SERVER_API_URL?: string } => ({
    NEXT_PUBLIC_API_URL: "https://api.closedloop-stage.ai",
  })
);

vi.mock("@/env", () => ({
  env: mockEnv,
}));

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window"
);

afterEach(() => {
  mockEnv.NEXT_PUBLIC_API_URL = "https://api.closedloop-stage.ai";
  Reflect.deleteProperty(mockEnv, "SERVER_API_URL");
  vi.unstubAllGlobals();

  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("resolveApiOrigin", () => {
  it("derives the matching API preview host from a request preview app host", () => {
    mockEnv.SERVER_API_URL = "http://api:3002";

    expect(
      resolveApiOrigin({
        nextUrl: {
          hostname: "app-stage-previewhash.preview.closedloop-stage.ai",
          protocol: "https:",
        },
      })
    ).toBe("https://api-stage-previewhash.preview.closedloop-stage.ai");
  });

  it("derives the matching API preview host from a browser preview app host", () => {
    stubBrowserLocation(
      "https:",
      "app-stage-browserhash.preview.closedloop-stage.ai"
    );

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-browserhash.preview.closedloop-stage.ai"
    );
  });

  it("keeps browser preview derivation ahead of configured public API URL", () => {
    mockEnv.NEXT_PUBLIC_API_URL =
      "https://api-stage-configuredhash.preview.closedloop-stage.ai";
    stubBrowserLocation(
      "https:",
      "app-stage-browserhash.preview.closedloop-stage.ai"
    );

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-browserhash.preview.closedloop-stage.ai"
    );
  });

  it("keeps browser preview derivation ahead of server-only API URL", () => {
    mockEnv.SERVER_API_URL = "http://api:3002";
    stubBrowserLocation(
      "https:",
      "app-stage-browserhash.preview.closedloop-stage.ai"
    );

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-browserhash.preview.closedloop-stage.ai"
    );
  });

  it("uses the server-only API URL on the server", () => {
    mockEnv.SERVER_API_URL = "http://api:3002";
    stubServerContext();

    expect(resolveApiOrigin()).toBe("http://api:3002");
  });

  it("keeps request preview derivation ahead of the server-only API URL", () => {
    mockEnv.SERVER_API_URL = "http://api:3002";
    stubServerContext();

    expect(
      resolveApiOrigin({
        nextUrl: {
          hostname: "app-stage-requesthash.preview.closedloop-stage.ai",
          protocol: "https:",
        },
      })
    ).toBe("https://api-stage-requesthash.preview.closedloop-stage.ai");
  });

  it("derives preview origin from plain request URLs", () => {
    expect(
      resolveApiOrigin({
        url: "https://app-stage-requesthash.preview.closedloop-stage.ai/api/integrations/github/callback",
      })
    ).toBe("https://api-stage-requesthash.preview.closedloop-stage.ai");
  });

  it("uses the configured public API URL when no server-only URL is present", () => {
    mockEnv.NEXT_PUBLIC_API_URL =
      "https://api-stage-configuredhash.preview.closedloop-stage.ai";

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-configuredhash.preview.closedloop-stage.ai"
    );
  });

  it("falls back to the configured public API URL on the server when no server-only URL is present", () => {
    mockEnv.NEXT_PUBLIC_API_URL =
      "https://api-stage-configuredhash.preview.closedloop-stage.ai";
    stubServerContext();

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-configuredhash.preview.closedloop-stage.ai"
    );
  });

  it("falls back to localhost when configured public URL is the local default", () => {
    mockEnv.NEXT_PUBLIC_API_URL = "http://localhost:3002";

    expect(resolveApiOrigin()).toBe("http://localhost:3002");
  });

  it("shows mismatched SHA app/API previews need the Playwright API-origin bridge", () => {
    const configuredApiOrigin =
      "https://api-stage-apihash.preview.closedloop-stage.ai";
    mockEnv.NEXT_PUBLIC_API_URL = configuredApiOrigin;
    stubBrowserLocation(
      "https:",
      "app-stage-apphash.preview.closedloop-stage.ai"
    );

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-apphash.preview.closedloop-stage.ai"
    );
    expect(resolveApiOrigin()).not.toBe(configuredApiOrigin);
  });
});

function stubBrowserLocation(protocol: string, hostname: string) {
  vi.stubGlobal("window", {
    location: {
      hostname,
      protocol,
    },
  });
}

function stubServerContext() {
  Reflect.deleteProperty(globalThis, "window");
}
