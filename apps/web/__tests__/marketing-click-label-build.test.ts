import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transformTrustedLabels } from "../../../scripts/analytics/trusted-label-transform.mjs";

const mocks = vi.hoisted(() => ({ base: {} as NextConfig }));

vi.mock("@repo/next-config", () => ({
  get config() {
    return mocks.base;
  },
  withAnalyzer: vi.fn(),
}));
vi.mock("@repo/observability/next-config", () => ({
  withLogging: (input: NextConfig) => input,
}));
vi.mock("fumadocs-mdx/next", () => ({
  createMDX: () => (input: NextConfig) => input,
}));
vi.mock("@/env", () => ({ env: {} }));

const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const LOADER = path.resolve(
  WEB_ROOT,
  "../../scripts/analytics/trusted-label-loader.cjs"
);

const EXISTING_LOADER = "existing-jsx-loader";
const EXISTING_CONDITION = { path: "app/**" };

afterEach(() => {
  mocks.base = {};
  vi.resetModules();
});

describe("marketing build provenance (ISS-12557)", () => {
  it("installs the shared label loader in both Next compilers", async () => {
    const previousWebpack = vi.fn((input: unknown) => input);
    mocks.base = { webpack: previousWebpack };
    const { default: config } = await import("../next.config");
    const webpackConfig = { module: { rules: [] as unknown[] } };
    const context = { dev: false };

    const result = config.webpack?.(webpackConfig, context as never);

    for (const pattern of ["*.tsx", "*.jsx"]) {
      expect(config.turbopack?.rules?.[pattern]).toEqual({
        loaders: [LOADER],
        condition: { not: "foreign" },
      });
    }
    expect(webpackConfig.module.rules).toEqual([
      {
        test: expect.any(RegExp),
        exclude: expect.any(RegExp),
        enforce: "pre",
        use: [LOADER],
      },
    ]);
    expect(previousWebpack).toHaveBeenCalledWith(webpackConfig, context);
    expect(result).toBe(webpackConfig);
  });

  it("keeps a pre-existing Turbopack JSX rule's loaders after its own", async () => {
    mocks.base = {
      turbopack: {
        rules: {
          "*.tsx": {
            loaders: [EXISTING_LOADER],
            condition: EXISTING_CONDITION,
          },
          "*.jsx": [EXISTING_LOADER],
          "*.mdx": { loaders: [EXISTING_LOADER] },
        },
      },
    };
    const { default: config } = await import("../next.config");

    expect(config.turbopack?.rules).toEqual({
      "*.tsx": {
        loaders: [LOADER, EXISTING_LOADER],
        condition: EXISTING_CONDITION,
      },
      "*.jsx": { loaders: [LOADER, EXISTING_LOADER] },
      "*.mdx": { loaders: [EXISTING_LOADER] },
    });
  });

  it.each([
    [
      "app/[locale]/(site)/components/home/hero-section.tsx",
      "visible",
      "Start Building",
    ],
    ["app/[locale]/components/site-banner.tsx", "accessible", "Dismiss banner"],
    [
      "app/[locale]/components/site-header-mobile.tsx",
      "accessible",
      "Open menu",
    ],
  ])("stamps product copy from %s", (file, channel, label) => {
    const source = path.join(WEB_ROOT, file);

    const { code } = transformTrustedLabels(
      readFileSync(source, "utf8"),
      source
    );

    expect(code).toContain(
      `data-analytics-${channel}-source={${JSON.stringify(JSON.stringify([label]))}}`
    );
  });
});
