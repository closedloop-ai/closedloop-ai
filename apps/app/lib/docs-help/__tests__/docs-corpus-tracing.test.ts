import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_CORPUS_TRACE_GLOB } from "../docs-corpus-trace-glob";

/**
 * ISS-10006 — the one check that can catch a docs corpus the deployment does not
 * carry.
 *
 * `outputFileTracingIncludes` is globbed by Next with `cwd` at the APP
 * directory. A pattern that reads as repo-relative resolves one level too deep,
 * matches nothing, and raises nothing — so the route handlers deploy without the
 * files they read and Help is a 503 in production while every suite here stays
 * green, because each of them stubs the read.
 *
 * This resolves the shipped pattern from `apps/app` the way the build will, and
 * fails on an empty match. `apps/api` carries the same guard shape for its
 * Prisma schema include, for the same class of silent miss.
 */
const APP_DIR = path.join(import.meta.dirname, "..", "..", "..");

function countUnder(dir: string): number {
  if (!existsSync(dir)) {
    return 0;
  }
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += statSync(full).isDirectory() ? countUnder(full) : 1;
  }
  return total;
}

describe("the docs corpus is traced into the Help route handlers", () => {
  it("resolves from apps/app to a corpus with files in it", () => {
    const root = path.join(
      APP_DIR,
      DOCS_CORPUS_TRACE_GLOB.replace("/**/*", "")
    );

    expect(existsSync(root), `${root} does not exist`).toBe(true);
    // Not `> 0`: a single stray file would satisfy that, and what must ship is
    // the corpus. The real tree is ~177 files.
    expect(countUnder(root)).toBeGreaterThan(100);
  });

  it("is spelled relative to the app, not to the monorepo root", () => {
    expect(DOCS_CORPUS_TRACE_GLOB.startsWith("./apps/")).toBe(false);
    expect(
      existsSync(path.join(APP_DIR, "apps", "web", "content", "docs"))
    ).toBe(false);
  });
});
