/**
 * ISS-11105 — `runTypecheckPasses` through its DEFAULT spawn, the real `tsc`.
 *
 * `run-typecheck-passes.test.ts` drives the inventory through an injected
 * `spawnProject`, so the production spawn's exit-code and output handling is
 * never reached in-process. These cases compile two throwaway one-file
 * projects: one clean, one with a type error.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTypecheckPasses } from "../scripts/typecheck-runner.mjs";

const TSC_TIMEOUT_MS = 120_000;
const CLEAN_SOURCE = "export const value: number = 1;\n";
const BROKEN_SOURCE = 'export const value: number = "not a number";\n';
const TYPE_ERROR = /TS2322/;

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runTypecheckPasses with the real tsc spawn", () => {
  it("passes a clean project and prints no output block for it", {
    timeout: TSC_TIMEOUT_MS,
  }, async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runTypecheckPasses({
      projects: [projectWith("clean", CLEAN_SOURCE)],
      concurrency: 1,
    });

    expect(code).toBe(0);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).not.toContain("[typecheck] ----- clean output -----");
    expect(
      lines.some((line) => line.startsWith("[typecheck] clean: ok in"))
    ).toBe(true);
  });

  it("reports tsc's own exit code and flushes its diagnostics under a banner", {
    timeout: TSC_TIMEOUT_MS,
  }, async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const code = await runTypecheckPasses({
      projects: [projectWith("broken", BROKEN_SOURCE)],
      concurrency: 1,
    });

    expect(code).toBe(1);
    const lines = log.mock.calls.map((call) => String(call[0]));
    const banner = lines.indexOf("[typecheck] ----- broken output -----");
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(lines[banner + 1]).toMatch(TYPE_ERROR);
    expect(
      lines.some((line) =>
        line.startsWith("[typecheck] broken: FAILED (exit 1) in")
      )
    ).toBe(true);
    const errors = error.mock.calls.map((call) => String(call[0]));
    expect(errors).toContain("[typecheck] 1 of 1 projects failed: broken");
    expect(errors.some((line) => line.includes("terminated on"))).toBe(false);
  });
});

function projectWith(name: string, source: string) {
  const root = mkdtempSync(path.join(tmpdir(), `iss11105-tsc-${name}-`));
  tempRoots.push(root);
  writeFileSync(path.join(root, "index.ts"), source, "utf8");
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "esnext", target: "esnext" },
      files: ["index.ts"],
    }),
    "utf8"
  );
  return {
    name,
    project: path.join(root, "tsconfig.json"),
    tsBuildInfoFile: path.join(root, "tsconfig.tsbuildinfo"),
  };
}
