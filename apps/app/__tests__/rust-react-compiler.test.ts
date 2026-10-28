// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

describe("React Compiler runs as Turbopack's Rust port (ISS-13006)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resolves reactCompiler and turbopackRustReactCompiler to true", async () => {
    const nextConfig = await loadNextConfig(undefined);
    // Next refuses the Rust flag without reactCompiler, so both are pinned.
    expect(nextConfig.reactCompiler).toBe(true);
    expect(
      nextConfig.experimental?.turbopackRustReactCompiler,
      "Without it the Babel plugin runs in Turbopack's Node.js loader pool and the build's peak memory returns to the level that OOM'd on Vercel (ISS-13006)."
    ).toBe(true);
  });

  it("leaves turbopackRustReactCompiler unset for the bundle analyzer", async () => {
    const nextConfig = await loadNextConfig("true");
    expect(
      nextConfig.experimental?.turbopackRustReactCompiler,
      "Next throws on this flag without Turbopack, so `ANALYZE=true pnpm --filter app build --webpack` fails while loading the config."
    ).toBeUndefined();
    expect(nextConfig.reactCompiler).toBe(true);
  });
});

async function loadNextConfig(analyze: string | undefined) {
  vi.stubEnv("ANALYZE", analyze);
  vi.resetModules();
  return (await import("../next.config")).default;
}
