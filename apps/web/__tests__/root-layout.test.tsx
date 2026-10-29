import { GoogleTagManager } from "@next/third-parties/google";
import type { BrowserAnalyticsContext } from "@repo/analytics/browser-context";
import { AppEnvironment } from "@repo/analytics/environment";
import { AnalyticsProvider } from "@repo/analytics/provider";
import { Children, isValidElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MarketingSessionReplay } from "@/components/marketing-session-replay";
import { MarketingSurfaceAnalyticsProvider } from "@/components/marketing-surface-analytics-adapter";

const mocks = vi.hoisted(() => ({
  env: {} as { CSP_ENABLED?: "true" | "false" },
  requestHeaders: new Headers(),
  headersCalls: 0,
}));

vi.mock("@/env", () => ({ env: mocks.env }));

/** Identity is all the wiring case needs; the controller has its own suite. */
vi.mock("@/components/marketing-session-replay", () => ({
  MarketingSessionReplay: () => null,
}));

/**
 * `@repo/analytics/provider` reaches `@posthog/next`, whose client entry has no
 * resolvable ESM subpath outside a bundler. The layout only passes the nonce
 * through it, so a pass-through stub keeps that thread intact.
 */
vi.mock("@repo/analytics/provider", () => ({
  AnalyticsProvider: ({ children }: { children: unknown }) => children,
}));

/**
 * `@repo/design-system/lib/fonts` loads Geist through `next/font/local`, which
 * only resolves inside Next's bundler. The value is a class string the layout
 * passes to `<html>`; nothing here asserts on it.
 */
vi.mock("@repo/design-system/lib/fonts", () => ({ fonts: "font-sans" }));

vi.mock("next/headers", () => ({
  headers: () => {
    mocks.headersCalls += 1;
    return Promise.resolve(mocks.requestHeaders);
  },
}));

const NONCE = "nonce-abc123";

beforeEach(() => {
  mocks.env.CSP_ENABLED = undefined;
  mocks.requestHeaders = new Headers();
  mocks.headersCalls = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("generateStaticParams", () => {
  test("prerenders one route per supported locale", async () => {
    const { generateStaticParams } = await import("@/app/[locale]/layout");

    expect(generateStaticParams()).toEqual([
      { locale: "en" },
      { locale: "de" },
      { locale: "es" },
      { locale: "fr" },
      { locale: "pt" },
      { locale: "zh" },
    ]);
  });
});

describe("the CSP nonce", () => {
  test("is read off the request and handed to Google Tag Manager", async () => {
    mocks.env.CSP_ENABLED = "true";
    mocks.requestHeaders.set("x-nonce", NONCE);

    expect(await nonceFromLayout()).toBe(NONCE);
  });

  test("is undefined when CSP is on but the request carries no nonce", async () => {
    mocks.env.CSP_ENABLED = "true";

    // `?? undefined` — `headers().get()` returns `null` for an absent header,
    // and a literal `null` reaching the script tag renders `nonce="null"`.
    expect(await nonceFromLayout()).toBeUndefined();
  });

  test("is not looked up at all when CSP_ENABLED is unset", async () => {
    mocks.env.CSP_ENABLED = undefined;
    mocks.requestHeaders.set("x-nonce", NONCE);

    // The header is present and still must not be used: with no policy there
    // is no nonce to satisfy, and reading it would make every render dynamic
    // for nothing. Unset is the only value that reaches this arm — see below.
    expect(await nonceFromLayout()).toBeUndefined();
    expect(mocks.headersCalls).toBe(0);
  });

  test('is still looked up for the literal "false", which is truthy', async () => {
    mocks.env.CSP_ENABLED = "false";
    mocks.requestHeaders.set("x-nonce", NONCE);

    // BEHAVIOR FLAGGED, NOT CHANGED. `CSP_ENABLED` is `z.enum(["true","false"])`
    // (packages/security/keys.ts), so the deployed off value is the STRING
    // "false" — truthy. `proxy.ts:44` tests it with `=== "true"` and skips the
    // policy; this layout tests it for truthiness and takes the read arm
    // anyway, opting every render into dynamic rendering for a header the
    // proxy never set. Harmless in output (no x-nonce is present in that
    // deployment, so the nonce is undefined either way) but not free. Changing
    // the predicate is a source change this tests-only ticket does not own.
    expect(await nonceFromLayout()).toBe(NONCE);
    expect(mocks.headersCalls).toBe(1);
  });
});

describe("the analytics provider", () => {
  test("tracks pageviews for the marketing surface (PRD-790)", async () => {
    const provider = await analyticsProvider();

    expect(provider?.type).toBe(AnalyticsProvider);
    expect(provider?.props.trackPageViews).toBe(true);
  });

  test("mounts the marketing click adapter inside the PostHog provider (ISS-12557)", async () => {
    const mounted = (await analyticsProviderChildren()).filter(
      (child) =>
        isValidElement(child) &&
        child.type === MarketingSurfaceAnalyticsProvider
    );

    expect(mounted).toHaveLength(1);
  });

  test("mounts marketing session replay inside it (ISS-12558)", async () => {
    const mounted = (await analyticsProviderChildren()).filter(
      (child) => isValidElement(child) && child.type === MarketingSessionReplay
    );

    expect(mounted).toHaveLength(1);
  });

  test("labels the production marketing domain as production (ISS-12554)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_ENVIRONMENT", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "www.closedloop.ai");
    vi.stubEnv("NEXT_PUBLIC_WEB_URL", "https://marketing.closedloop.ai");

    expect((await analyticsProvider())?.props.context?.environment).toBe(
      AppEnvironment.Production
    );
  });

  test("keeps the stage marketing domain out of production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_ENVIRONMENT", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "marketing.stage.example");
    vi.stubEnv("NEXT_PUBLIC_WEB_URL", "https://www.closedloop.ai");

    expect((await analyticsProvider())?.props.context?.environment).toBe(
      AppEnvironment.Stage
    );
  });

  test("falls back to NEXT_PUBLIC_WEB_URL without a production domain", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_ENVIRONMENT", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("NEXT_PUBLIC_WEB_URL", "https://www.closedloop.ai");

    expect((await analyticsProvider())?.props.context?.environment).toBe(
      AppEnvironment.Production
    );
  });

  test("ignores a copied production domain off Vercel", async () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "");
    vi.stubEnv("NEXT_PUBLIC_APP_ENVIRONMENT", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "closedloop.ai");
    vi.stubEnv("NEXT_PUBLIC_WEB_URL", "http://localhost:3001");

    expect((await analyticsProvider())?.props.context?.environment).toBe(
      AppEnvironment.Development
    );
  });
});

async function nonceFromLayout(): Promise<string | undefined> {
  const { default: RootLayout } = await import("@/app/[locale]/layout");

  const html = (await RootLayout({
    children: null,
    params: Promise.resolve({ locale: "en" }),
  })) as ReactElement<{ children: ReactElement<{ nonce?: string }>[] }>;

  const tagManager = html.props.children.find(
    (child) => child.type === GoogleTagManager
  );

  if (!tagManager) {
    throw new Error("layout rendered no GoogleTagManager");
  }

  return tagManager.props.nonce;
}

async function analyticsProvider(): Promise<
  | ReactElement<{
      context?: BrowserAnalyticsContext;
      trackPageViews?: boolean;
    }>
  | undefined
> {
  const { default: RootLayout } = await import("@/app/[locale]/layout");
  const html = (await RootLayout({
    children: null,
    params: Promise.resolve({ locale: "en" }),
  })) as ReactElement<{ children: ReactElement<{ children: unknown }>[] }>;
  const body = html.props.children.find((child) => child.type === "body");
  return body?.props.children as
    | ReactElement<{
        context?: BrowserAnalyticsContext;
        trackPageViews?: boolean;
      }>
    | undefined;
}

async function analyticsProviderChildren() {
  const { default: RootLayout } = await import("@/app/[locale]/layout");

  const html = (await RootLayout({
    children: null,
    params: Promise.resolve({ locale: "en" }),
  })) as ReactElement<{ children: ReactElement<{ children: unknown }>[] }>;

  const body = html.props.children.find((child) => child.type === "body");
  const provider = body?.props.children as
    | ReactElement<{ children: ReactElement[] }>
    | undefined;
  return Children.toArray(provider?.props.children);
}
