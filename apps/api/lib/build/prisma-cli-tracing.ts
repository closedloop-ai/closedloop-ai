import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * ISS-5983: the Next file-tracing globs for the Prisma CLI's RUNTIME dependency
 * closure, computed from the pnpm store at build time.
 *
 * The ensure route spawns `prisma migrate deploy`; tracing cannot see a spawn,
 * so the CLI has to be named explicitly. Naming it is not one glob: the CLI
 * `require`s `@prisma/config` and `@prisma/engines`, `@prisma/config` pulls
 * `c12`, `effect`, `empathic` and `deepmerge-ts`, and pnpm wires all of that
 * together with SYMLINKS inside `node_modules/.pnpm/<pkg>/node_modules/` —
 * which node-glob does not follow (Next calls it without `follow`). A `**`
 * under the CLI's own directory therefore stops at the CLI's own files.
 *
 * So the INCLUDE closure is walked here instead of hardcoded: a hand-written
 * list would be long, and silently wrong the first time a Prisma bump changes a
 * transitive dependency. A small probe-derived EXCLUSION set is then applied on
 * top — see {@link UNUSED_CLOSURE_LEAVES}, which carries the same rot risk this
 * paragraph warns about and says so. Failure is non-fatal — an unrecognizable
 * layout yields no globs rather than breaking every api build. Note the route's
 * runtime layout probe checks the config, schema, migrations, entrypoint and
 * engine binary; it does NOT check that the traced closure is complete.
 */

const PNPM_STORE_RELATIVE = path.join("node_modules", ".pnpm");
const CLI_PACKAGE_NAME = "prisma";
/** Guards against a pathological store; the real closure is dozens of entries. */
const MAX_VISITED_PACKAGES = 500;

/**
 * ISS-8556: dependencies of the CLI's two heaviest packages that the migrate
 * path never loads, skipped so neither they nor their own subtrees are traced.
 *
 * `prisma` declares `@prisma/studio-core` and `@prisma/dev` — Studio and the
 * local dev server. Both MUST STAY: `build/cli.js` requires
 * `@prisma/studio-core/data/bff` and `@prisma/dev/internal/state` at TOP LEVEL,
 * so the CLI cannot start without them whatever subcommand runs. What is unused
 * is most of what hangs off them.
 *
 * DERIVED BY PROBE, NOT BY READING. A `Module._load` hook was given every
 * declared dependency of both packages and the list was narrowed by re-running
 * the real spawned entrypoint until it started: whatever it demanded came back
 * off the block list. `@prisma/dev` eagerly loads eight of its own
 * dependencies — `@prisma/get-platform`, `pathe`, `proper-lockfile`,
 * `std-env`, `valibot`, `zeptomatch`, `get-port-please` and `remeda` — so those
 * stay traced. The 18 below are what remained, and with all 18 blocked
 * `migrate status`, `migrate deploy` AND `migrate resolve --rolled-back` each
 * ran to completion against a real database with zero blocked loads.
 *
 * `migrate resolve` is in that list deliberately: it is the RECOVERY spawn
 * (migration-pipeline.ts), and a migrate that can spawn while its recovery
 * cannot is the worse failure.
 *
 * Guessing here is ISS-6403, which shipped once already.
 *
 * WHAT THIS DOES NOT PROTECT. The probe intercepts CJS `require` only —
 * ESM `import()`, `require.resolve` feature probes and `fs`-based asset reads
 * (pglite ships WASM) would behave differently between "blocked from
 * `Module._load`" and "absent from the bundle". And nothing checks the closure
 * at runtime: the route's layout probe verifies the config, schema, migrations
 * directory, CLI entrypoint and engine binary, NOT that any of these packages
 * are present. A wrongly-excluded package therefore surfaces as
 * MODULE_NOT_FOUND inside the spawned CLI on a deployed function, with no build
 * or probe signal first. `preview-schemas-ensure-cli-tracing.test.ts` asserts
 * every name here still resolves in the real store, which catches an entry that
 * has gone stale but not one that was wrong to add.
 */
export const UNUSED_CLOSURE_LEAVES: ReadonlySet<string> = new Set([
  // @prisma/studio-core's UI half. `data/bff` is the only entry cli.js touches.
  "@radix-ui/react-toggle",
  "@visx/curve",
  "@visx/event",
  "@visx/grid",
  "@visx/group",
  "@visx/responsive",
  "@visx/scale",
  "@visx/shape",
  "d3-array",
  "d3-shape",
  "elkjs",
  // @prisma/dev's local-database and HTTP-server half.
  "@electric-sql/pglite",
  "@electric-sql/pglite-socket",
  "@electric-sql/pglite-tools",
  "@prisma/query-plan-executor",
  "@prisma/streams-local",
  "find-my-way",
  "foreground-child",
]);

/**
 * The `@prisma/dev` dependencies the spawned CLI EAGERLY loads, discovered by
 * the same probe that produced {@link UNUSED_CLOSURE_LEAVES} — it demanded each
 * of these in turn until it started. They must never join the exclusion set;
 * the guard against that is in preview-schemas-ensure-cli-tracing.test.ts.
 */
export const PROBED_REQUIRED_DEV_DEPENDENCIES: readonly string[] = [
  "@prisma/get-platform",
  "pathe",
  "proper-lockfile",
  "std-env",
  "valibot",
  "zeptomatch",
  "get-port-please",
  "remeda",
];

type StoreIndex = {
  entries: string[];
  storeDirectory: string;
};

function readStoreIndex(monorepoRoot: string): StoreIndex | null {
  const storeDirectory = path.join(monorepoRoot, PNPM_STORE_RELATIVE);
  try {
    return { entries: readdirSync(storeDirectory), storeDirectory };
  } catch {
    return null;
  }
}

/**
 * The store directories holding `packageName`. pnpm names them
 * `<name with "/" as "+">@<version>[_<peer hash>]`, and the character right
 * after the name is always `@`, so a prefix match cannot collide with a
 * longer package name.
 */
function storeDirectoriesFor(index: StoreIndex, packageName: string): string[] {
  const prefix = `${packageName.replace("/", "+")}@`;
  return index.entries.filter((entry) => entry.startsWith(prefix));
}

function readRuntimeDependencies(
  index: StoreIndex,
  storeDirectory: string,
  packageName: string
): string[] {
  const manifestPath = path.join(
    index.storeDirectory,
    storeDirectory,
    "node_modules",
    packageName,
    "package.json"
  );
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}

/**
 * Tracing globs, RELATIVE TO `apps/api` — Next matches include globs with the
 * Next project directory as cwd, not `outputFileTracingRoot`.
 */
export function prismaCliTracingIncludes(monorepoRoot: string): string[] {
  const index = readStoreIndex(monorepoRoot);
  if (!index) {
    return [];
  }

  const globs: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [CLI_PACKAGE_NAME];

  while (queue.length > 0 && visited.size < MAX_VISITED_PACKAGES) {
    const packageName = queue.shift();
    if (
      packageName === undefined ||
      visited.has(packageName) ||
      UNUSED_CLOSURE_LEAVES.has(packageName)
    ) {
      continue;
    }
    visited.add(packageName);

    for (const storeDirectory of storeDirectoriesFor(index, packageName)) {
      globs.push(
        `../../${PNPM_STORE_RELATIVE}/${storeDirectory}/node_modules/${packageName}/**`
      );
      queue.push(
        ...readRuntimeDependencies(index, storeDirectory, packageName)
      );
    }
  }

  return globs;
}
