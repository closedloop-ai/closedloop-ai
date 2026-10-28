import { AnalyticsProvider } from "@repo/analytics/provider";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestHeaders, mockEnv } = vi.hoisted(() => ({
  requestHeaders: new Map<string, string>(),
  mockEnv: {
    CSP_ENABLED: false,
    NEXT_PUBLIC_API_URL: "https://api.closedloop.ai",
    NEXT_PUBLIC_APP_URL: "https://app.closedloop.ai",
    NEXT_PUBLIC_WEB_URL: "https://closedloop.ai",
    NEXT_PUBLIC_DOCS_URL: "https://closedloop.ai/docs",
    // The container-internal address: never an origin a browser can reach.
    SERVER_API_URL: "http://api:3002",
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => requestHeaders.get(name) ?? null,
  }),
}));
vi.mock("next/font/google", () => ({
  Silkscreen: () => ({ variable: "font-pixel" }),
}));
vi.mock("@repo/design-system/lib/fonts", () => ({ fonts: "test-font-class" }));
vi.mock("@/env", () => ({ env: mockEnv }));
vi.mock("@/lib/deployment-pin", () => ({
  resolveApiDeploymentPin: async () => undefined,
}));

async function renderRootLayoutTree(): Promise<ReactElement> {
  const { default: RootLayout } = await import("../app/layout");
  return (await RootLayout({ children: null })) as ReactElement;
}

/** Every `<link>` element the layout places in its tree, without rendering it. */
function linkElements(
  node: ReactNode
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    return node.flatMap(linkElements);
  }
  if (!isValidElement<Record<string, unknown>>(node)) {
    return [];
  }
  const own = node.type === "link" ? [node] : [];
  return [...own, ...linkElements(node.props.children as ReactNode)];
}

describe("root layout BFF preconnect (ISS-7492)", () => {
  beforeEach(() => {
    requestHeaders.clear();
  });

  // Unconditional, so a case that throws mid-way cannot leak its override into
  // every later case in this worker.
  afterEach(() => {
    mockEnv.NEXT_PUBLIC_API_URL = "https://api.closedloop.ai";
  });

  it("tells the browser to connect to the public API origin", async () => {
    const preconnects = linkElements(await renderRootLayoutTree()).filter(
      (link) => link.props.rel === "preconnect"
    );

    expect(preconnects.map((link) => link.props.href)).toEqual([
      "https://api.closedloop.ai",
    ]);
    // Without it the preconnected socket is not the one a credentialed-by-header
    // CORS fetch can reuse.
    expect(preconnects[0]?.props.crossOrigin).toBe("anonymous");
  });

  it("emits no hint when only the local fallback is configured", async () => {
    mockEnv.NEXT_PUBLIC_API_URL = "http://localhost:3002";

    const preconnects = linkElements(await renderRootLayoutTree()).filter(
      (link) => link.props.rel === "preconnect"
    );

    expect(preconnects).toEqual([]);
  });

  it("emits no hint on a preview, whose reads go to the derived api twin", async () => {
    // The normal preview build: the configured origin is stage's, but every
    // browser read targets the `api-` twin of the host the page is served on.
    mockEnv.NEXT_PUBLIC_API_URL = "https://api.stage.example";
    requestHeaders.set("host", "app-stage-git-main.preview.stage.example");

    const preconnects = linkElements(await renderRootLayoutTree()).filter(
      (link) => link.props.rel === "preconnect"
    );

    expect(preconnects).toEqual([]);
  });

  it("derives no origin from the request Host header", async () => {
    // A `Host` a caller controls only decides whether to hint; it never
    // reaches the `<link>` in the document.
    requestHeaders.set("host", "app.attacker.example");

    const preconnects = linkElements(await renderRootLayoutTree()).filter(
      (link) => link.props.rel === "preconnect"
    );

    expect(preconnects.map((link) => link.props.href)).toEqual([
      "https://api.closedloop.ai",
    ]);
  });
});

describe("root layout PostHog session headers (ISS-11929)", () => {
  afterEach(() => {
    mockEnv.NEXT_PUBLIC_API_URL = "https://api.closedloop.ai";
    Reflect.deleteProperty(mockEnv, "POSTHOG_TRACING_HEADERS_ENABLED");
  });

  it("hands PostHog no origin when POSTHOG_TRACING_HEADERS_ENABLED is false", async () => {
    Object.assign(mockEnv, { POSTHOG_TRACING_HEADERS_ENABLED: "false" });

    const [provider] = analyticsProviders(await renderRootLayoutTree());

    expect(provider).toBeDefined();
    expect(provider?.props.apiOrigin).toBeNull();
  });

  it("hands the public API origin to PostHog as the only host for its session headers", async () => {
    const [provider] = analyticsProviders(await renderRootLayoutTree());

    expect(provider?.props.apiOrigin).toBe("https://api.closedloop.ai");
  });

  it("hands PostHog no origin when only the local fallback is configured", async () => {
    // localhost:3002 shares its hostname with the desktop gateway, and
    // posthog-js matches on hostname alone.
    mockEnv.NEXT_PUBLIC_API_URL = "http://localhost:3002";

    const [provider] = analyticsProviders(await renderRootLayoutTree());

    expect(provider).toBeDefined();
    expect(provider?.props.apiOrigin).toBeNull();
  });
});

function analyticsProviders(
  node: ReactNode
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    return node.flatMap(analyticsProviders);
  }
  if (!isValidElement<Record<string, unknown>>(node)) {
    return [];
  }
  const own = node.type === AnalyticsProvider ? [node] : [];
  return [...own, ...analyticsProviders(node.props.children as ReactNode)];
}
