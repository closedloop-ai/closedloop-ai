import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveApiOrigin } from "@/lib/api-origin";

const mockEnv = vi.hoisted((): { NEXT_PUBLIC_API_URL: string } => ({
  NEXT_PUBLIC_API_URL: "https://api.stage.example",
}));

vi.mock("@/env", () => ({
  env: mockEnv,
}));

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window"
);

afterEach(() => {
  mockEnv.NEXT_PUBLIC_API_URL = "https://api.stage.example";
  vi.unstubAllGlobals();

  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("resolveApiOrigin", () => {
  it("derives the matching API preview host from a request preview app host", () => {
    expect(
      resolveApiOrigin({
        nextUrl: {
          hostname: "app-stage-previewhash.preview.stage.example",
          protocol: "https:",
        },
      })
    ).toBe("https://api-stage-previewhash.preview.stage.example");
  });

  it("derives the matching API preview host from a browser preview app host", () => {
    stubBrowserLocation(
      "https:",
      "app-stage-browserhash.preview.stage.example"
    );

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-browserhash.preview.stage.example"
    );
  });

  it("keeps browser preview derivation ahead of configured public API URL", () => {
    mockEnv.NEXT_PUBLIC_API_URL =
      "https://api-stage-configuredhash.preview.stage.example";
    stubBrowserLocation(
      "https:",
      "app-stage-browserhash.preview.stage.example"
    );

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-browserhash.preview.stage.example"
    );
  });

  it("shows mismatched SHA app/API previews need the Playwright API-origin bridge", () => {
    const configuredApiOrigin =
      "https://api-stage-apihash.preview.stage.example";
    mockEnv.NEXT_PUBLIC_API_URL = configuredApiOrigin;
    stubBrowserLocation("https:", "app-stage-apphash.preview.stage.example");

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-apphash.preview.stage.example"
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
