import type { NextConfig } from "next";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `next.config.ts` decorates whatever `@repo/next-config` hands it, so what it
 * does depends entirely on the shape of the base config's existing `rewrites`.
 * Stubbing that base is the only way to reach the three shapes it branches on
 * (array / object / absent) — the real one returns just one of them.
 */
const mocks = vi.hoisted(() => ({
  baseConfig: {} as NextConfig,
  env: {} as { ANALYZE?: string },
  analyzerCalls: [] as NextConfig[],
}));

vi.mock("@repo/next-config", () => ({
  get config() {
    return mocks.baseConfig;
  },
  withAnalyzer: (input: NextConfig) => {
    mocks.analyzerCalls.push(input);
    return { ...input, analyzed: true };
  },
}));

vi.mock("@repo/observability/next-config", () => ({
  withLogging: (input: NextConfig) => input,
}));

vi.mock("fumadocs-mdx/next", () => ({
  createMDX: () => (input: NextConfig) => input,
}));

vi.mock("@/env", () => ({ env: mocks.env }));

const TRAINING_REWRITE = {
  source: "/ib-claude-training",
  destination: "/ib-claude-training.html",
};

beforeEach(() => {
  mocks.baseConfig = {};
  mocks.env.ANALYZE = undefined;
  mocks.analyzerCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the /ib-claude-training rewrite", () => {
  test("is the only rewrite when the base config declares none", async () => {
    const config = await loadConfig();

    await expect(resolveRewrites(config)).resolves.toEqual({
      beforeFiles: [TRAINING_REWRITE],
    });
  });

  test("keeps an array of base rewrites, demoted to afterFiles", async () => {
    const existing = { source: "/old", destination: "/new" };
    mocks.baseConfig = { rewrites: () => Promise.resolve([existing]) };
    const config = await loadConfig();

    // The training rewrite has to win the race against the `[locale]` dynamic
    // segment, so it must be `beforeFiles` and the base rewrites `afterFiles`.
    // Swapping the two lets `/ib-claude-training` be read as a locale.
    await expect(resolveRewrites(config)).resolves.toEqual({
      beforeFiles: [TRAINING_REWRITE],
      afterFiles: [existing],
    });
  });

  test("goes in front of base rewrites that are already beforeFiles", async () => {
    const existing = { source: "/old", destination: "/new" };
    mocks.baseConfig = {
      rewrites: () => Promise.resolve({ beforeFiles: [existing] }),
    };
    const config = await loadConfig();

    const resolved = await resolveRewrites(config);

    expect(resolved).toEqual({ beforeFiles: [TRAINING_REWRITE, existing] });
    // Order, not just membership: appended instead of prepended, the base
    // rewrite matches first.
    expect((resolved as { beforeFiles: unknown[] }).beforeFiles[0]).toEqual(
      TRAINING_REWRITE
    );
  });

  test("preserves the other keys of a rewrite object that has no beforeFiles", async () => {
    const existing = { source: "/old", destination: "/new" };
    mocks.baseConfig = {
      rewrites: () => Promise.resolve({ afterFiles: [existing] }),
    };
    const config = await loadConfig();

    // `?? []` — spreading an absent `beforeFiles` must not drop `afterFiles`.
    await expect(resolveRewrites(config)).resolves.toEqual({
      afterFiles: [existing],
      beforeFiles: [TRAINING_REWRITE],
    });
  });
});

describe("production-only redirects", () => {
  test("redirects /legal to /legal/privacy in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const config = await loadConfig();

    await expect(config.redirects?.()).resolves.toEqual([
      { source: "/legal", destination: "/legal/privacy", statusCode: 301 },
    ]);
  });

  test("declares no redirects outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const config = await loadConfig();

    expect(config.redirects).toBeUndefined();
  });
});

describe("the bundle analyzer", () => {
  test("wraps the config when ANALYZE is the string 'true'", async () => {
    mocks.env.ANALYZE = "true";
    const config = await loadConfig();

    expect(mocks.analyzerCalls).toHaveLength(1);
    expect(config).toHaveProperty("analyzed", true);
  });

  test("leaves the config alone for any other ANALYZE value", async () => {
    mocks.env.ANALYZE = "false";
    const config = await loadConfig();

    expect(mocks.analyzerCalls).toHaveLength(0);
    expect(config).not.toHaveProperty("analyzed");
  });
});

async function loadConfig(): Promise<NextConfig> {
  const { default: config } = await import("@/next.config");

  return config;
}

function resolveRewrites(config: NextConfig) {
  if (typeof config.rewrites !== "function") {
    throw new Error("config declared no rewrites function");
  }

  return config.rewrites();
}
