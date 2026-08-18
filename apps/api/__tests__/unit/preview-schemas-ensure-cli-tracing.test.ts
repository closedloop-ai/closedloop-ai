import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prismaCliTracingIncludes } from "@/lib/build/prisma-cli-tracing";

/**
 * ISS-5983: the ensure route spawns the Prisma CLI, so the CLI's whole runtime
 * closure has to be named in `outputFileTracingIncludes`. pnpm links that
 * closure with symlinks that node-glob will not follow, so the walk here is
 * what makes the closure reachable at all.
 *
 * The synthetic store below is what proves the WALK — a real-store assertion
 * alone could pass on a closure that stops at the first level.
 */

let storeRoot: string | null = null;

function writePackage(
  monorepoRoot: string,
  storeDirectory: string,
  packageName: string,
  dependencies: Record<string, string> = {}
): void {
  const packageDirectory = path.join(
    monorepoRoot,
    "node_modules",
    ".pnpm",
    storeDirectory,
    "node_modules",
    packageName
  );
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: packageName, dependencies })
  );
}

function createSyntheticStore(): string {
  const root = mkdtempSync(path.join(tmpdir(), "iss5983-store-"));
  storeRoot = root;
  writePackage(root, "prisma@7.8.0_abc", "prisma", {
    "@prisma/config": "7.8.0",
    "@prisma/engines": "7.8.0",
  });
  writePackage(root, "@prisma+config@7.8.0_magicast@0.5.3", "@prisma/config", {
    c12: "3.4.0",
  });
  writePackage(root, "@prisma+engines@7.8.0", "@prisma/engines");
  writePackage(root, "c12@3.4.0", "c12");
  // A package that nothing in the closure depends on.
  writePackage(root, "unrelated@1.0.0", "unrelated");
  return root;
}

afterEach(() => {
  if (storeRoot) {
    rmSync(storeRoot, { recursive: true, force: true });
    storeRoot = null;
  }
});

describe("prismaCliTracingIncludes", () => {
  it("walks past the CLI's direct dependencies into their own dependencies", () => {
    const globs = prismaCliTracingIncludes(createSyntheticStore());

    // c12 is TWO hops out (prisma → @prisma/config → c12). A walk that stopped
    // at the CLI's direct dependencies would ship a CLI that cannot load its
    // own config.
    expect(globs).toContain(
      "../../node_modules/.pnpm/c12@3.4.0/node_modules/c12/**"
    );
    expect(globs).toContain(
      "../../node_modules/.pnpm/@prisma+config@7.8.0_magicast@0.5.3/node_modules/@prisma/config/**"
    );
    expect(globs).toContain(
      "../../node_modules/.pnpm/@prisma+engines@7.8.0/node_modules/@prisma/engines/**"
    );
  });

  it("leaves packages outside the CLI's closure out of the function bundle", () => {
    const globs = prismaCliTracingIncludes(createSyntheticStore());

    expect(globs.some((glob) => glob.includes("unrelated"))).toBe(false);
  });

  it("writes every glob relative to apps/api, where Next matches them", () => {
    const globs = prismaCliTracingIncludes(createSyntheticStore());

    expect(globs.length).toBeGreaterThan(0);
    for (const glob of globs) {
      expect(glob.startsWith("../../node_modules/.pnpm/")).toBe(true);
    }
  });

  it("degrades to no globs instead of breaking the build on an unknown layout", () => {
    expect(
      prismaCliTracingIncludes(path.join(tmpdir(), "no-such-root"))
    ).toEqual([]);
  });

  it("resolves the real CLI, its config loader and its native engines", () => {
    const monorepoRoot = path.join(import.meta.dirname, "..", "..", "..", "..");

    const globs = prismaCliTracingIncludes(monorepoRoot);

    expect(globs.some((glob) => glob.endsWith("/prisma/**"))).toBe(true);
    expect(globs.some((glob) => glob.endsWith("/@prisma/config/**"))).toBe(
      true
    );
    expect(globs.some((glob) => glob.endsWith("/@prisma/engines/**"))).toBe(
      true
    );
  });
});
