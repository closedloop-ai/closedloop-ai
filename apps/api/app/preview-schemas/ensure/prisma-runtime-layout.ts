import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { PRISMA_CLI_ENTRY_ENV } from "@repo/database/scripts/migration-pipeline";

/**
 * ISS-5983: locates, inside a deployed serverless bundle, the files
 * `prisma migrate deploy` needs when it is SPAWNED from a runtime function.
 *
 * The migration pipeline spawns the Prisma CLI with no cwd and no extra env
 * beyond `DATABASE_URL` — correct for the build, whose cwd is
 * `packages/database` and whose PATH carries pnpm's `.bin`. A function has
 * neither, so the caller must supply them. Four things have to be found:
 *
 * 1. the CLI's own entrypoint, for `PRISMA_CLI_ENTRY`;
 * 2. the directories that make the entrypoint's bare `require`s resolvable, for
 *    `NODE_PATH` — bundling copies the CLI's dependency files but not the pnpm
 *    symlinks that connect them;
 * 3. `packages/database/prisma-runtime`, the dependency-free config directory
 *    the CLI discovers from cwd (Prisma 7 reads `datasource.url` ONLY from a
 *    config file);
 * 4. the NATIVE `schema-engine-<platform>` binary, for
 *    `PRISMA_SCHEMA_ENGINE_BINARY` — the CLI's own `__dirname`-relative lookup
 *    is not guaranteed to survive bundling;
 * 5. `esm-store-resolver.mjs` beside the config, for the CLI's `--import` —
 *    ISS-6781: `NODE_PATH` (2) reaches only CommonJS `require`s, and the CLI's
 *    config loader `import`s ES modules that walk the same missing symlinks.
 *
 * Nothing here guesses a path that might not exist: every candidate is probed,
 * and an unresolvable layout returns a typed failure with the roots it tried so
 * the route can report it instead of spawning a CLI that cannot work.
 *
 * ISS-6403 is why (1) is the entrypoint and not a bin directory. Probing for a
 * FILE NAMED `prisma` found pnpm's shim, which is present in the bundle and
 * cannot load the CLI out of it — a precondition check that passed on evidence
 * it had, rather than on the thing it was asserting.
 */

/** Filesystem probes, injected so the resolution logic is testable. */
export type LayoutProbe = {
  exists: (candidate: string) => boolean;
  listDir: (candidate: string) => string[];
};

export type MigrateRuntimeLayout = {
  /** Repo-root-equivalent directory inside the bundle. */
  root: string;
  /**
   * Directory holding the dependency-free `prisma.config.mjs`. Passed to the
   * pipeline as the per-invocation `prismaCli.cwd`, never applied to this
   * process — see `applyMigrateRuntimeLayout`.
   */
  configDir: string;
  /** Absolute path of the CLI entrypoint the pipeline runs under `node`. */
  cliEntry: string;
  /**
   * Absolute path of the ESM store resolver the CLI is preloaded with. Reaches
   * the spawn as the per-invocation `prismaCli.preload`, like `configDir`.
   */
  esmResolverEntry: string;
  /**
   * ISS-6810: the traced `prisma/migrations` directory, for the pipeline's OWN
   * readers (at-head probe, pre-stamp, plain-index build, ownership preflight),
   * which resolve it off `process.cwd()` by default — and a function's cwd is
   * `apps/api`, not `packages/database`. Reaches the run as
   * `prismaCli.migrationsDir`, like `configDir` and `esmResolverEntry`.
   */
  migrationsDir: string;
  /** Absolute path of the native schema engine, or `null` when not bundled. */
  schemaEngineBinary: string | null;
  /** `NODE_PATH` entries that make the CLI's bare `require`s resolvable. */
  modulePaths: string[];
};

export type MigrateRuntimeLayoutResult =
  | { ok: true; layout: MigrateRuntimeLayout }
  | { ok: false; reason: string; rootsTried: string[] };

const DATABASE_PACKAGE_RELATIVE = path.join("packages", "database");
const RUNTIME_CONFIG_RELATIVE = path.join(
  DATABASE_PACKAGE_RELATIVE,
  "prisma-runtime"
);
const RUNTIME_CONFIG_FILE = "prisma.config.mjs";
const ESM_RESOLVER_FILE = "esm-store-resolver.mjs";
const PRISMA_RELATIVE = path.join(DATABASE_PACKAGE_RELATIVE, "prisma");
const SCHEMA_RELATIVE = path.join(PRISMA_RELATIVE, "schema.prisma");
const MIGRATIONS_RELATIVE = path.join(PRISMA_RELATIVE, "migrations");
const CLI_PACKAGE_NAME = "prisma";
/** The CLI's entrypoint, relative to its own package directory. */
const CLI_ENTRY_RELATIVE = path.join("build", "index.js");
const ENGINES_PACKAGE_NAME = "@prisma/engines";
const SCHEMA_ENGINE_PREFIX = "schema-engine-";
/** How far above the working directory a bundle root may sit. */
const MAX_ROOT_DEPTH = 6;

const defaultProbe: LayoutProbe = {
  exists: (candidate) => existsSync(candidate),
  listDir: (candidate) => {
    try {
      return readdirSync(candidate);
    } catch {
      return [];
    }
  },
};

/**
 * The working directory and its ancestors, nearest first. Vercel's traced files
 * keep their paths relative to `outputFileTracingRoot` (the monorepo root),
 * while cwd inside the function is the Next project directory, so the bundle
 * root is one of cwd's ancestors — but which one is a platform detail, not a
 * contract worth hardcoding.
 */
export function candidateRoots(workingDirectory: string): string[] {
  const roots: string[] = [];
  let current = workingDirectory;
  for (let depth = 0; depth < MAX_ROOT_DEPTH; depth += 1) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return roots;
}

/**
 * Directories that may hold `packageName`, in resolution order: every matching
 * pnpm store entry first, then the workspace-local paths.
 *
 * The store entries lead, because they are what Next file tracing actually
 * copies. pnpm links the short workspace-local path to the store with a
 * SYMLINK, and node-glob does not follow symlinks, so that convenient path can
 * exist in the repo and be absent from the bundle. The workspace-local paths
 * stay as the fallback for a hoisted, non-pnpm install.
 */
function packageDirCandidates(
  root: string,
  packageName: string,
  probe: LayoutProbe
): string[] {
  const packageSegments = packageName.split("/");
  const nodeModules = path.join(root, "node_modules");
  const storeDirectory = path.join(nodeModules, ".pnpm");
  const storePrefix = `${packageName.replace("/", "+")}@`;
  const storeDirs = probe
    .listDir(storeDirectory)
    .filter((entry) => entry.startsWith(storePrefix))
    .map((entry) =>
      path.join(storeDirectory, entry, "node_modules", ...packageSegments)
    );
  return [
    ...storeDirs,
    path.join(nodeModules, ...packageSegments),
    path.join(root, "apps", "api", "node_modules", ...packageSegments),
    path.join(
      root,
      DATABASE_PACKAGE_RELATIVE,
      "node_modules",
      ...packageSegments
    ),
  ];
}

/**
 * Finds the CLI's ENTRYPOINT, not a launcher that claims to reach one.
 *
 * ISS-6403: the version this replaces accepted a directory holding a file named
 * `prisma` — pnpm's `.bin` shim. The shim is a shell script that `require`s
 * `<bin>/../prisma/build/index.js` through a symlink no glob traced, so it was
 * present in the bundle and unrunnable, and this function's own promise to fail
 * rather than "spawn a CLI that cannot work" was not kept. Probing the
 * entrypoint the spawn will actually execute is what makes that promise true.
 */
function findCliEntry(root: string, probe: LayoutProbe): string | null {
  for (const packageDir of packageDirCandidates(
    root,
    CLI_PACKAGE_NAME,
    probe
  )) {
    const entry = path.join(packageDir, CLI_ENTRY_RELATIVE);
    if (probe.exists(entry)) {
      return entry;
    }
  }
  return null;
}

/**
 * The version a pnpm store entry encodes, read off a path that runs through
 * one. `prisma@7.8.0_@types+react@19.2.17` and `@prisma+engines@7.8.0` both
 * yield `7.8.0`; the peer-hash suffix after `_` is not part of the version, and
 * a path with no store segment (a hoisted install) yields `null`.
 */
function storeEntryVersion(candidate: string): string | null {
  const segments = candidate.split(path.sep);
  const storeIndex = segments.indexOf(".pnpm");
  const entry = storeIndex === -1 ? undefined : segments[storeIndex + 1];
  if (!entry) {
    return null;
  }
  const versionIndex = entry.indexOf("@", 1);
  if (versionIndex === -1) {
    return null;
  }
  return entry.slice(versionIndex + 1).split("_")[0] ?? null;
}

/**
 * Finds the platform schema engine by NAME rather than by platform string: the
 * bundle carries whichever `schema-engine-<platform>` the Linux install
 * produced, and that identifier is Prisma's to change.
 *
 * Anchored to the CLI that was actually chosen. Both lookups prefix-match the
 * store and would otherwise each take their own first hit, so a store holding
 * two Prisma versions — a peer variant, or a bump mid-flight — could pair one
 * CLI with another version's engine, and every `exists` probe would still pass.
 * `prisma` and `@prisma/engines` are published in lockstep, so the CLI's own
 * store version is the tie-break. When nothing matches it (a hoisted install
 * has no store version at all) the search order is unchanged.
 */
function findSchemaEngineBinary(
  root: string,
  probe: LayoutProbe,
  cliEntry: string
): string | null {
  const cliVersion = storeEntryVersion(cliEntry);
  const candidates = packageDirCandidates(root, ENGINES_PACKAGE_NAME, probe);
  const ordered = [
    ...candidates.filter(
      (candidate) =>
        cliVersion !== null && storeEntryVersion(candidate) === cliVersion
    ),
    ...candidates.filter(
      (candidate) =>
        cliVersion === null || storeEntryVersion(candidate) !== cliVersion
    ),
  ];

  for (const engineDir of ordered) {
    const binary = probe
      .listDir(engineDir)
      .find((entry) => entry.startsWith(SCHEMA_ENGINE_PREFIX));
    if (binary) {
      return path.join(engineDir, binary);
    }
  }
  return null;
}

/**
 * Every directory that holds packages under their bare names, for `NODE_PATH`.
 *
 * ISS-6403, second half. Naming the entrypoint got the CLI started; its first
 * bare `require("@prisma/config")` still failed. Node resolves that by walking
 * up from `prisma/build/`, which lands on
 * `.pnpm/prisma@<v>/node_modules/@prisma/config` — a SYMLINK to a sibling store
 * entry. The tracing globs copy the sibling's FILES but not the symlink (Next
 * calls node-glob without `follow`), so entrypoint and dependency are both in
 * the bundle with no resolution path between them.
 *
 * Each store entry's own `node_modules` holds its package under the canonical
 * bare name, so listing them all gives node a flat fallback that resolves the
 * whole closure — `@prisma/config`, and transitively `c12` and `effect` — at
 * every depth, without needing any symlink.
 *
 * Caveat: when the store holds two versions of one package, NODE_PATH ORDER
 * decides which one wins, and that order is the store's directory listing. For
 * this spawn that is acceptable — the CLI's closure is pinned by one install,
 * and a possibly-wrong minor beats a certain MODULE_NOT_FOUND.
 */
function collectModulePaths(root: string, probe: LayoutProbe): string[] {
  const nodeModules = path.join(root, "node_modules");
  const storeDirectory = path.join(nodeModules, ".pnpm");
  const storePaths = probe
    .listDir(storeDirectory)
    .map((entry) => path.join(storeDirectory, entry, "node_modules"));
  return [...storePaths, nodeModules];
}

/**
 * An operator-supplied `PRISMA_CLI_ENTRY`, or `null` when there is none.
 * Whitespace-only counts as none: the value is a path, and a blank one names
 * nothing, so honoring it would only guarantee the spawn fails.
 */
function readCliEntryOverride(env: Partial<NodeJS.ProcessEnv>): string | null {
  const override = env[PRISMA_CLI_ENTRY_ENV]?.trim();
  return override ? override : null;
}

function resolveForRoot(
  root: string,
  probe: LayoutProbe,
  overrideCliEntry: string | null
): MigrateRuntimeLayout | null {
  const configDir = path.join(root, RUNTIME_CONFIG_RELATIVE);
  const esmResolverEntry = path.join(configDir, ESM_RESOLVER_FILE);
  const migrationsDir = path.join(root, MIGRATIONS_RELATIVE);
  const hasConfig = probe.exists(path.join(configDir, RUNTIME_CONFIG_FILE));
  const hasResolver = probe.exists(esmResolverEntry);
  const hasSchema = probe.exists(path.join(root, SCHEMA_RELATIVE));
  const hasMigrations = probe.exists(migrationsDir);
  if (!(hasConfig && hasResolver && hasSchema && hasMigrations)) {
    return null;
  }

  const cliEntry = overrideCliEntry ?? findCliEntry(root, probe);
  if (!cliEntry) {
    return null;
  }

  return {
    root,
    configDir,
    esmResolverEntry,
    migrationsDir,
    cliEntry,
    schemaEngineBinary: findSchemaEngineBinary(root, probe, cliEntry),
    modulePaths: collectModulePaths(root, probe),
  };
}

/**
 * `env` is read for an operator's `PRISMA_CLI_ENTRY` override, which is
 * resolved HERE rather than deferred to the apply step. That is the whole
 * point: the override is the value the pipeline will actually spawn, so it is
 * the value that has to be probed. Leaving it to `applyMigrateRuntimeLayout` —
 * which refuses to overwrite a set variable — validated `layout.cliEntry` and
 * then ran something else, the same shape of unchecked precondition ISS-6403
 * fixed for the `.bin` shim.
 */
export function resolveMigrateRuntimeLayout(
  workingDirectory: string,
  probe: LayoutProbe = defaultProbe,
  env: Partial<NodeJS.ProcessEnv> = process.env
): MigrateRuntimeLayoutResult {
  const rootsTried = candidateRoots(workingDirectory);
  const overrideCliEntry = readCliEntryOverride(env);
  if (overrideCliEntry && !probe.exists(overrideCliEntry)) {
    return {
      ok: false,
      reason:
        `${PRISMA_CLI_ENTRY_ENV} names "${overrideCliEntry}", which is not present. ` +
        "Unset it to use the bundled Prisma CLI entrypoint.",
      rootsTried,
    };
  }

  for (const root of rootsTried) {
    const layout = resolveForRoot(root, probe, overrideCliEntry);
    if (layout) {
      return { ok: true, layout };
    }
  }
  return {
    ok: false,
    reason:
      `Could not locate the bundled Prisma CLI entrypoint (${CLI_PACKAGE_NAME}/${CLI_ENTRY_RELATIVE}), runtime config, ESM store resolver, schema and migrations directory. ` +
      "Check outputFileTracingIncludes for this route.",
    rootsTried,
  };
}

/**
 * Applies a resolved layout to the current process so the pipeline's Prisma CLI
 * spawn inherits everything it needs.
 *
 * ISS-6403 replaced a `PATH` prepend with `PRISMA_CLI_ENTRY`. Prepending a
 * directory only asserts where to LOOK; the pipeline then resolved a `.bin`
 * shim that could not load its own entrypoint out of the bundle. Naming the
 * entrypoint removes the lookup, and with it the symlink the lookup depended
 * on.
 *
 * `NODE_PATH` is the other half: the entrypoint's own bare `require`s walk up
 * through the same missing symlinks. The pipeline spawns with `...process.env`,
 * so a value set here reaches the child at ITS startup, which is when node
 * reads `NODE_PATH` — setting it on an already-running process would do
 * nothing. See `collectModulePaths` for what goes in it and what that costs.
 *
 * `layout.configDir` and `layout.esmResolverEntry` are deliberately NOT applied
 * here. They are the config directory the CLI must discover `prisma.config.mjs`
 * from and the resolver it must be preloaded with, and they reach the spawn as
 * per-invocation `prismaCli` options on the pipeline call instead — see
 * `PrismaCliOptions`. ISS-6403 Finding 5 started as a `proc.chdir()` into
 * that directory and then became an env var; both are process-global, and a
 * value that belongs to ONE ensure request must not be readable by every other
 * caller on a warm instance (review: shafty023).
 *
 * Idempotent on purpose: a warm instance serves many requests, and Fluid
 * Compute may run them concurrently. Every mutation here is either a no-op or
 * writes the same value it wrote last time, so concurrent invocations cannot
 * observe a half-applied environment.
 *
 * `PRISMA_CLI_ENTRY` is written unconditionally, and that is not a change of
 * heart about operator overrides: `resolveMigrateRuntimeLayout` has already
 * adopted a valid override as `layout.cliEntry` and rejected an invalid one, so
 * the write is the operator's own value whenever they set one. Skipping the
 * write instead is what let an unprobed value reach the spawn.
 *
 * ISS-6728: `NODE_PATH` is MERGED for the same reason, having previously been
 * skipped whenever one was already set. That guard read as deference to an
 * operator and was in fact deference to AWS Lambda, which pre-sets `NODE_PATH`
 * (`/opt/nodejs/...:/var/runtime/node_modules:/var/task`) on every Vercel
 * function. The skip therefore fired on EVERY production request and never once
 * on a developer's machine, so the store directories reached no spawn and the
 * CLI died in module resolution before it ran. `NODE_PATH` decides what
 * RESOLVES, which decides whether anything executes at all — so the store
 * directories go first and the platform's own entries are preserved after them.
 *
 * The merge keeps the idempotence promised above by construction rather than by
 * luck: inherited entries that are already store directories are dropped, so
 * re-applying maps the merged value onto itself instead of growing it. See
 * `mergeNodePathEntries`.
 *
 * `PRISMA_SCHEMA_ENGINE_BINARY` keeps its skip, and that is a considered
 * difference, not an oversight. No platform sets it — it is Prisma's own name,
 * so the only value that can be there is one an operator put there — and it
 * names a single binary rather than a search path, so there is nothing to merge:
 * two engine binaries cannot both run. Its guard still means what it says.
 */
export function applyMigrateRuntimeLayout(
  layout: MigrateRuntimeLayout,
  proc: Pick<NodeJS.Process, "env"> = process
): void {
  proc.env[PRISMA_CLI_ENTRY_ENV] = layout.cliEntry;

  if (layout.modulePaths.length > 0) {
    proc.env.NODE_PATH = mergeNodePathEntries(
      layout.modulePaths,
      proc.env.NODE_PATH
    );
  }

  if (layout.schemaEngineBinary && !proc.env.PRISMA_SCHEMA_ENGINE_BINARY) {
    proc.env.PRISMA_SCHEMA_ENGINE_BINARY = layout.schemaEngineBinary;
  }
}

/**
 * The store directories first, then whatever the platform already had, minus
 * the store directories themselves.
 *
 * Dropping the duplicates is what makes this safe to run on a warm instance:
 * `merge(paths, merge(paths, x))` is `merge(paths, x)`, so a second request
 * against the same process writes the identical string rather than a longer
 * one. A plain prepend would grow `NODE_PATH` once per request forever.
 */
function mergeNodePathEntries(
  modulePaths: string[],
  inherited: string | undefined
): string {
  const storeDirs = new Set(modulePaths);
  const preserved = (inherited ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && !storeDirs.has(entry));
  return [...modulePaths, ...preserved].join(path.delimiter);
}
