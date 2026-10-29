import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isUnreachableApiPreviewHost,
  resolveApiOrigin,
  resolveBrowserApiOrigin,
  resolvePreconnectApiOrigin,
} from "@/lib/api-origin";

const mockEnv = vi.hoisted(
  (): { NEXT_PUBLIC_API_URL: string; SERVER_API_URL?: string } => ({
    NEXT_PUBLIC_API_URL: "https://api.stage.example",
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
  mockEnv.NEXT_PUBLIC_API_URL = "https://api.stage.example";
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

  it("keeps browser preview derivation ahead of server-only API URL", () => {
    mockEnv.SERVER_API_URL = "http://api:3002";
    stubBrowserLocation(
      "https:",
      "app-stage-browserhash.preview.stage.example"
    );

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-browserhash.preview.stage.example"
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
          hostname: "app-stage-requesthash.preview.stage.example",
          protocol: "https:",
        },
      })
    ).toBe("https://api-stage-requesthash.preview.stage.example");
  });

  it("derives a prototype pin alias's API twin pin", () => {
    stubBrowserLocation(
      "https:",
      "app-stage-pin-git-functional-prototype-inbox.preview.stage.example"
    );

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-pin-git-functional-prototype-inbox.preview.stage.example"
    );
  });

  it("derives preview origin from plain request URLs", () => {
    expect(
      resolveApiOrigin({
        url: "https://app-stage-requesthash.preview.stage.example/api/integrations/github/callback",
      })
    ).toBe("https://api-stage-requesthash.preview.stage.example");
  });

  it("uses the configured public API URL when no server-only URL is present", () => {
    mockEnv.NEXT_PUBLIC_API_URL =
      "https://api-stage-configuredhash.preview.stage.example";

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-configuredhash.preview.stage.example"
    );
  });

  it("falls back to the configured public API URL on the server when no server-only URL is present", () => {
    mockEnv.NEXT_PUBLIC_API_URL =
      "https://api-stage-configuredhash.preview.stage.example";
    stubServerContext();

    expect(resolveApiOrigin()).toBe(
      "https://api-stage-configuredhash.preview.stage.example"
    );
  });

  it("falls back to localhost when configured public URL is the local default", () => {
    mockEnv.NEXT_PUBLIC_API_URL = "http://localhost:3002";

    expect(resolveApiOrigin()).toBe("http://localhost:3002");
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

/**
 * ISS-9797: the same rewrite, read as a question about the address the browser
 * is on. The shell uses this to say what a per-deployment preview link is
 * instead of rendering `Teams unavailable` and `— Unavailable` over data it
 * never reached.
 */
describe("isUnreachableApiPreviewHost", () => {
  it("reports a per-deployment preview alias as unreachable", () => {
    expect(
      isUnreachableApiPreviewHost("app-stage-dx28itjr4.preview.stage.example")
    ).toBe(true);
  });

  it("reports a per-deployment vercel.app alias as unreachable", () => {
    expect(isUnreachableApiPreviewHost("app-stage-dx28itjr4.vercel.app")).toBe(
      true
    );
  });

  it("accepts the stable git-branch preview alias, whose API twin exists", () => {
    expect(
      isUnreachableApiPreviewHost("app-stage-git-main.preview.stage.example")
    ).toBe(false);
  });

  // ISS-11921: the pin alias scripts/ci/prototype-pin-alias.ts assigns to a
  // functional prototype's app-stage preview.
  it("accepts a prototype pin alias, whose pinned API twin exists", () => {
    expect(
      isUnreachableApiPreviewHost(
        "app-stage-pin-git-functional-prototype-inbox.preview.stage.example"
      )
    ).toBe(false);
  });

  it("accepts the stable git-branch vercel.app alias", () => {
    expect(
      isUnreachableApiPreviewHost("app-stage-git-main-closedloop.vercel.app")
    ).toBe(false);
  });

  it("accepts the stable environment host", () => {
    expect(isUnreachableApiPreviewHost("app.stage.example")).toBe(false);
  });

  it("accepts local development, which never derives an API host", () => {
    expect(isUnreachableApiPreviewHost("localhost:3000")).toBe(false);
  });

  it("ignores a port when classifying the host", () => {
    expect(
      isUnreachableApiPreviewHost(
        "app-stage-dx28itjr4.preview.stage.example:443"
      )
    ).toBe(true);
  });

  it("accepts a host the rewrite does not apply to at all", () => {
    expect(
      isUnreachableApiPreviewHost("api-stage-dx28itjr4.preview.stage.example")
    ).toBe(false);
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

describe("resolveBrowserApiOrigin", () => {
  it("names the public API origin, never the container-internal one", () => {
    // Set on every server that runs in Docker; a browser cannot open a socket
    // to it, so a connection hint naming it would warm nothing.
    mockEnv.SERVER_API_URL = "http://api:3002";

    expect(resolveBrowserApiOrigin()).toBe("https://api.stage.example");
  });

  it("names nothing when only the local fallback is configured", () => {
    mockEnv.NEXT_PUBLIC_API_URL = "http://localhost:3002";

    expect(resolveBrowserApiOrigin()).toBeNull();
  });
});

describe("resolvePreconnectApiOrigin", () => {
  it.each([
    ["app-stage-git-main.preview.stage.example"],
    ["app-stage-git-main-closedloop.vercel.app:443"],
  ])(
    "hints nothing on the preview host %s, even with a configured origin",
    (host) => {
      // Reads from that page go to its derived `api-` twin, not to the
      // configured stage origin, so a hint naming stage would warm nothing.
      expect(resolvePreconnectApiOrigin(host)).toBeNull();
    }
  );

  it("hints the configured origin on a host the browser does not rewrite", () => {
    expect(resolvePreconnectApiOrigin("app.stage.example")).toBe(
      "https://api.stage.example"
    );
  });
});
