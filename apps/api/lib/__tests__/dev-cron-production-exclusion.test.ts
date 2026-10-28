import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
// Runtime uses of the compiler API import `typescript6`: the bare `typescript`
// specifier resolves to typescript@7's native build, whose JS API is a stub
// until 7.1 (AGENTS.md, `no-bare-typescript-import`).
import ts from "typescript6";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * ISS-8152 (davetho, #6048) — the production entrypoint must not import the
 * dev cron scheduler.
 *
 * The ticket says the scheduler stays out of production builds. A runtime guard
 * cannot deliver that on its own: `server:start` and the Dockerfile CMD both run
 * `server.ts`, so while that file imported the scheduler it was in the
 * production runtime's import graph no matter what the guard decided. The fix
 * is the `server.ts` / `server-dev.ts` split, and this is the assertion that
 * holds it — re-adding the import to `server.ts`, or pointing `server:dev` back
 * at it, fails here rather than in review.
 *
 * The walk follows in-repo specifiers: relative ones, AND `@/…`, which
 * `apps/api/tsconfig.json` maps to `./*` — this app's own root, not a package
 * boundary. Missing that alias was the whole hole in the first version of this
 * file: `@/` is the dominant import spelling in `apps/api`, so the walk stopped
 * at the first aliased edge and would have stayed green while
 * `import … from "@/lib/dev-cron-scheduler"` re-admitted the module anywhere in
 * the production chain (#6048 review, found independently by three reviewers).
 *
 * Package specifiers (`next`, `@repo/*`) are genuine boundaries and are not
 * followed. Known remaining blind spot: dynamic `import()` and `require()`
 * edges are not visited, so this is a strong guard against the ordinary
 * spelling rather than a proof.
 */

const API_ROOT = resolve(import.meta.dirname, "../..");
const SCHEDULER_MODULE = resolve(API_ROOT, "lib/dev-cron-scheduler.ts");
const RELATIVE_SPECIFIER = /^\.\.?\//;
const APP_ALIAS_PREFIX = "@/";
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Whether a specifier can resolve inside this app at all. */
function isInAppSpecifier(specifier: string): boolean {
  return (
    RELATIVE_SPECIFIER.test(specifier) || specifier.startsWith(APP_ALIAS_PREFIX)
  );
}

/** The file an in-app specifier resolves to, or null when it is not TS source. */
function resolveModule(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith(APP_ALIAS_PREFIX)
    ? join(API_ROOT, specifier.slice(APP_ALIAS_PREFIX.length))
    : join(dirname(fromFile), specifier);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (
      (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) &&
      existsSync(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Every in-app import/export specifier in one source file.
 *
 * Both spellings, unfiltered, so one memo serves every walk below regardless of
 * which specifier arms that walk follows; the arm is applied at the walk, not
 * here.
 *
 * Parsed without parent pointers: the walks below overlap almost entirely and
 * nothing reads `.parent`. Uncached and with pointers, walking per case re-read
 * and re-parsed the same files once per case (ISS-9275).
 */
function inAppSpecifiersOf(file: string): string[] {
  const memoised = specifiersByFile.get(file);
  if (memoised !== undefined) {
    return memoised;
  }
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const isModuleRef =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier);
    if (isModuleRef) {
      const specifier = (
        (node as ts.ImportDeclaration | ts.ExportDeclaration)
          .moduleSpecifier as ts.StringLiteral
      ).text;
      if (isInAppSpecifier(specifier)) {
        found.push(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  specifiersByFile.set(file, found);
  return found;
}

/**
 * Every in-app module reachable from `entry`.
 *
 * `followAlias: false` drops `@/…` edges and follows relative ones only, which
 * is what the walk would see if the alias arm of {@link resolveModule} stopped
 * resolving. The alias-reach case holds the two arms against each other, so
 * nothing here may short-circuit on the arm being off (ISS-12771).
 */
function reachableFrom(
  entry: string,
  { followAlias }: { followAlias: boolean }
): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const specifier of inAppSpecifiersOf(file)) {
      if (!followAlias && specifier.startsWith(APP_ALIAS_PREFIX)) {
        continue;
      }
      const target = resolveModule(file, specifier);
      if (target !== null && !seen.has(target)) {
        queue.push(target);
      }
    }
  }
  return seen;
}

describe("the dev cron scheduler is absent from the production import graph", () => {
  // Built once. Every case below asks a question about the same three graphs, so
  // walking them per case made the FIRST case pay for all five — 13.4s across
  // this file on a green run, against Vitest's 5s default, which is how it
  // tipped over on a slower day (ISS-9275). The assertions are unchanged; only
  // the derivation moved to where shared setup belongs.
  let graphs: EntryGraphs;

  beforeAll(() => {
    // `server-dev.ts` first: its graph contains all of production's but
    // `server.ts` itself, and the relative-only walk is a subset of
    // production's, so the two later walks are served almost entirely from the
    // per-file memo.
    graphs = {
      development: reachableFrom(resolve(API_ROOT, "server-dev.ts"), {
        followAlias: true,
      }),
      production: reachableFrom(resolve(API_ROOT, "server.ts"), {
        followAlias: true,
      }),
      productionWithoutAlias: reachableFrom(resolve(API_ROOT, "server.ts"), {
        followAlias: false,
      }),
    };
  }, GRAPH_BUILD_TIMEOUT_MS);

  it("is unreachable from server.ts, the production entrypoint", () => {
    // Named rather than just counted, so a failure says which chain re-admitted
    // it instead of only that something did.
    expect(
      [...graphs.production].map((file) => relative(API_ROOT, file))
    ).not.toContain(relative(API_ROOT, SCHEDULER_MODULE));
  });

  it("IS reachable from server-dev.ts, so the split is real and not just absent", () => {
    // Without this half, deleting the scheduler outright would pass the test
    // above and prove nothing.
    expect(graphs.development.has(SCHEDULER_MODULE)).toBe(true);
  });

  it("keeps the two entrypoints wired to the commands that run them", () => {
    // The exclusion is only worth anything while `server:start` runs the file
    // without the import and `server:dev` runs the one with it.
    const scripts = JSON.parse(
      readFileSync(resolve(API_ROOT, "package.json"), "utf8")
    ).scripts as Record<string, string>;

    expect(scripts["server:start"]).toContain("server.ts");
    expect(scripts["server:start"]).not.toContain("server-dev.ts");
    expect(scripts["server:dev"]).toContain("server-dev.ts");
    // The link the Dockerfile CMD actually traverses: `pnpm --filter api start`.
    // Repointing `start` at the dev entrypoint would put the scheduler in the
    // production container with everything above still green (#6048 review).
    expect(scripts.start).toContain("server:start");
    expect(scripts.start).not.toContain("server:dev");
  });

  it("walks through the app's own `@/` alias, not just relative edges", () => {
    // The guard is only as good as its reach. `app/compute-targets/service.ts`
    // imports `@/app/compute-targets/protected-gateways`, so if the alias were
    // unresolved the walk would stop there and the absence assertion above would
    // be near-vacuous. Asserting a known alias-only module is reached pins the
    // reach itself.
    //
    // The pin must be reachable ONLY through `@/` (ISS-12771). Several
    // app-rooted modules are reached on relative edges alone, and pinning one of
    // those holds this assertion green with `@/` resolution entirely broken.
    //
    // Alias-only is a property of the two edges into the module, which anyone
    // may respell: `service.ts` reaches it directly as
    // `@/app/compute-targets/protected-gateways`, and `compute-target-record.ts`
    // reaches it relatively but is itself only reached through `@/`. Rewriting
    // either of those `service.ts` lines to `./` would make the pin reachable on
    // relative edges alone and leave the reach assertion unable to fail. So the
    // property is asserted here against the relative-only walk rather than
    // recorded as a one-off measurement in a PR body (#9003 review).
    const aliasOnlyModule = resolve(
      API_ROOT,
      "app/compute-targets/protected-gateways.ts"
    );
    const pin = relative(API_ROOT, aliasOnlyModule);

    expect(
      existsSync(aliasOnlyModule),
      `the pin moved: ${pin} no longer exists, so this case measures nothing. Repoint it at a module reachable from server.ts only through \`@/\`.`
    ).toBe(true);
    expect(
      graphs.productionWithoutAlias.has(aliasOnlyModule),
      `the pin is no longer alias-only: ${pin} is reachable from server.ts on relative edges alone, so the next assertion cannot fail and \`@/\` reach is unguarded.`
    ).toBe(false);
    expect(
      graphs.production.has(aliasOnlyModule),
      `\`@/\` alias reach is broken: ${pin} is reachable from server.ts only through \`@/\`, and the walk did not reach it, so the absence assertion above is near-vacuous.`
    ).toBe(true);
    // The walk is broad because of the alias, not in spite of it. Derived from
    // the relative-only walk rather than a fixed floor: a fixed one passes at
    // the relative-only size, so the breadth claim survives `@/` resolution
    // being broken (#9003 review).
    expect(graphs.production.size).toBeGreaterThan(
      graphs.productionWithoutAlias.size
    );
  });

  it("shares one bootstrap, so the dev entrypoint cannot drift from production", () => {
    const bootstrap = resolve(API_ROOT, "lib/start-api-server.ts");

    expect(graphs.production.has(bootstrap)).toBe(true);
    expect(graphs.development.has(bootstrap)).toBe(true);
  });
});

/** The graphs every case in this file reads. */
type EntryGraphs = {
  development: Set<string>;
  production: Set<string>;
  /** Production with the `@/` arm off — the counterfactual, not a claim. */
  productionWithoutAlias: Set<string>;
};

/** Per-file specifier memo backing {@link inAppSpecifiersOf}. */
const specifiersByFile = new Map<string, string[]>();

/**
 * Budget for the one graph build, pinned rather than left on Vitest's generic
 * 10s hook default.
 *
 * Parsing every module reachable from the two entrypoints (67 distinct files as
 * measured, the third walk served from the memo) is real work with a known
 * cost, not a wait on anything: it measures well under a second cold locally,
 * and this file has run up to ~13x
 * slower inside the coverage lane, where `apps/api` shares an 8-core runner
 * with a second package's whole suite. 30s is ~4x that worst observed cost.
 *
 * It is a bound, not a licence. The five cases keep Vitest's 5s default, and
 * they now assert against an already-built graph, so a case that exceeds 5s is
 * once again a real signal rather than this walk being charged to whichever
 * test happened to run first (ISS-9275).
 */
const GRAPH_BUILD_TIMEOUT_MS = 30_000;
