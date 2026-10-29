import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROBED_REQUIRED_DEV_DEPENDENCIES,
  prismaCliTracingIncludes,
  UNUSED_CLOSURE_LEAVES,
} from "@/lib/build/prisma-cli-tracing";

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

  // ISS-8556: the exclusion set applied on top of the walk.
  it("skips the probed-unused leaves AND the subtrees only they reach", () => {
    const root = mkdtempSync(path.join(tmpdir(), "iss8556-store-"));
    storeRoot = root;
    writePackage(root, "prisma@7.10.0_abc", "prisma", {
      "@prisma/studio-core": "0.33.0",
    });
    writePackage(root, "@prisma+studio-core@0.33.0", "@prisma/studio-core", {
      "d3-shape": "3.2.0",
      elkjs: "0.11.1",
    });
    writePackage(root, "d3-shape@3.2.0", "d3-shape", { "d3-path": "3.1.0" });
    writePackage(root, "d3-path@3.1.0", "d3-path");
    writePackage(root, "elkjs@0.11.1", "elkjs");

    const globs = prismaCliTracingIncludes(root);

    expect(globs.some((glob) => glob.includes("d3-shape@"))).toBe(false);
    expect(globs.some((glob) => glob.includes("elkjs@"))).toBe(false);
    // Skipping a leaf must also drop what only IT reached — that subtree is
    // where the weight actually is.
    expect(globs.some((glob) => glob.includes("d3-path@"))).toBe(false);
  });

  it("still traces @prisma/studio-core and @prisma/dev, which cli.js requires at top level", () => {
    // NOT an arbitrary pair to protect. `build/cli.js` requires
    // `@prisma/studio-core/data/bff` and `@prisma/dev/internal/state` at top
    // level, so the spawned CLI dies MODULE_NOT_FOUND without them whatever
    // subcommand runs (ISS-6403 is that failure, shipped). Excluding them looks
    // like an obvious ~60 MB saving and is the reason this test exists.
    const monorepoRoot = path.join(import.meta.dirname, "..", "..", "..", "..");

    const globs = prismaCliTracingIncludes(monorepoRoot);

    expect(globs.some((glob) => glob.endsWith("/@prisma/studio-core/**"))).toBe(
      true
    );
    expect(globs.some((glob) => glob.endsWith("/@prisma/dev/**"))).toBe(true);
  });

  it("still traces every dependency the probe caught the CLI eagerly loading", () => {
    // Over-pruning is the failure mode the exclusion set introduces, and it is
    // invisible until a deployed function spawns the CLI. These eight are the
    // ones `@prisma/dev` demanded during the narrowing probe.
    const monorepoRoot = path.join(import.meta.dirname, "..", "..", "..", "..");

    const globs = prismaCliTracingIncludes(monorepoRoot);

    for (const dependency of PROBED_REQUIRED_DEV_DEPENDENCIES) {
      expect(
        globs.some((glob) => glob.endsWith(`/${dependency}/**`)),
        `${dependency} is loaded by the spawned CLI and must stay traced`
      ).toBe(true);
    }
  });

  it("has no exclusion entry that matches nothing in the real store", () => {
    // A name that resolves to no store directory excludes nothing, so it is
    // either drift or a typo — and it makes the recorded saving wrong. This is
    // exactly how a stale `chart.js` entry survived a Prisma bump that had
    // already removed the package (ISS-8556 review).
    //
    // It is only as good as the store it runs against: a developer whose
    // `.pnpm` still holds packages the current lockfile dropped will see this
    // pass on an entry CI would red. CI installs `--frozen-lockfile`, so CI is
    // the authority here.
    const storeDirectory = path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "node_modules",
      ".pnpm"
    );
    // Degrade loudly rather than throwing ENOENT: apps/api is a root-sandbox
    // package, so Stryker can spawn this from a sandbox with no populated
    // store, and a crash there would read as a defect in the code under test.
    if (!existsSync(storeDirectory)) {
      expect.fail(
        `no pnpm store at ${storeDirectory}; this assertion needs a populated node_modules and cannot report a verdict without one`
      );
    }
    const entries = readdirSync(storeDirectory);

    for (const name of UNUSED_CLOSURE_LEAVES) {
      const prefix = `${name.replace("/", "+")}@`;
      expect(
        entries.some((entry) => entry.startsWith(prefix)),
        `${name} is in UNUSED_CLOSURE_LEAVES but resolves to no installed package`
      ).toBe(true);
    }
  });
});
