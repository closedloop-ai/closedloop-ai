import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `@repo/seo/metadata` reads `VERCEL_PROJECT_PRODUCTION_URL` at module load, so
 * the import is deferred until the stub is in place. Every literal below is
 * written from the contract, not read back off `createMetadata`.
 */
let createMetadata: typeof import("@repo/seo/metadata").createMetadata;

const PRODUCTION_HOST = "www.closedloop.ai";

// `NODE_ENV` is `test` under vitest, which is what selects `http` here.
const EXPECTED_METADATA_BASE = new URL(`http://${PRODUCTION_HOST}`);

const SHARED_METADATA = {
  applicationName: "Closedloop.ai",
  metadataBase: EXPECTED_METADATA_BASE,
  authors: [{ name: "Closedloop.ai", url: "https://closedloop.ai" }],
  creator: "Closedloop.ai",
  formatDetection: { telephone: false },
  publisher: "Closedloop.ai",
  twitter: { card: "summary_large_image" },
};

beforeAll(async () => {
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", PRODUCTION_HOST);
  vi.resetModules();
  ({ createMetadata } = await import("@repo/seo/metadata"));
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("createMetadata openGraph.url", () => {
  it("omits openGraph.url entirely when no path is passed, the shape every apps/app call site uses", () => {
    const metadata = createMetadata({
      title: "Signing in",
      description: "Completing your sign-in.",
    });

    expect(metadata).toStrictEqual({
      ...SHARED_METADATA,
      title: "Signing in | Closedloop.ai",
      description: "Completing your sign-in.",
      appleWebApp: {
        capable: true,
        statusBarStyle: "default",
        title: "Signing in | Closedloop.ai",
      },
      openGraph: {
        title: "Signing in | Closedloop.ai",
        description: "Completing your sign-in.",
        type: "website",
        siteName: "Closedloop.ai",
        locale: "en_US",
      },
    });
  });

  // No `image` here on purpose: `createPageMetadata` forwards only title,
  // description and path, so pairing the two would let a mutation that gates
  // `openGraph.url` on `image` keep this case green while stripping og:url
  // from every page that actually ships.
  it("sets openGraph.url to the root-relative path, from path alone", () => {
    const metadata = createMetadata({
      title: "Pricing",
      description: "Simple pricing.",
      path: "/pricing",
    });

    expect(metadata).toStrictEqual({
      ...SHARED_METADATA,
      title: "Pricing | Closedloop.ai",
      description: "Simple pricing.",
      appleWebApp: {
        capable: true,
        statusBarStyle: "default",
        title: "Pricing | Closedloop.ai",
      },
      openGraph: {
        title: "Pricing | Closedloop.ai",
        description: "Simple pricing.",
        type: "website",
        siteName: "Closedloop.ai",
        locale: "en_US",
        url: "/pricing",
      },
    });
  });
});
