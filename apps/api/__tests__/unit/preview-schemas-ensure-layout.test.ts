import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PRISMA_CLI_ENTRY_ENV,
  runMigrateWithRetry,
} from "@repo/database/scripts/migration-pipeline";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { LayoutProbe } from "@/app/preview-schemas/ensure/prisma-runtime-layout";
import {
  applyMigrateRuntimeLayout,
  candidateRoots,
  resolveMigrateRuntimeLayout,
} from "@/app/preview-schemas/ensure/prisma-runtime-layout";

const BUNDLE_ROOT = "/var/task";
const WORKING_DIRECTORY = "/var/task/apps/api/.next/server";
const CONFIG_FILE = `${BUNDLE_ROOT}/packages/database/prisma-runtime/prisma.config.mjs`;
const RESOLVER_FILE = `${BUNDLE_ROOT}/packages/database/prisma-runtime/esm-store-resolver.mjs`;
/** The real resolver pair, copied into the synthetic bundle below as-is. */
const REAL_RUNTIME_CONFIG_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "database",
  "prisma-runtime"
);
const ESM_RESOLVER_FILES = [
  "esm-store-resolver.mjs",
  "esm-store-resolver-hooks.mjs",
];
const SCHEMA_FILE = `${BUNDLE_ROOT}/packages/database/prisma/schema.prisma`;
const MIGRATIONS_DIR = `${BUNDLE_ROOT}/packages/database/prisma/migrations`;
const PNPM_STORE = `${BUNDLE_ROOT}/node_modules/.pnpm`;
const PNPM_CLI_DIR = "prisma@7.8.0_@types+react@19.2.17";
const PNPM_ENGINE_DIR = "@prisma+engines@7.8.0";
const CLI_ENTRY = `${PNPM_STORE}/${PNPM_CLI_DIR}/node_modules/prisma/build/index.js`;
const ENGINE_BINARY = `${PNPM_STORE}/${PNPM_ENGINE_DIR}/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x`;
/**
 * pnpm's launcher. Traced into the bundle before ISS-6403 and useless there: it
 * `require`s `<bin>/../prisma/build/index.js` through a symlink no glob copied.
 */
const BIN_SHIM = `${BUNDLE_ROOT}/node_modules/.bin/prisma`;

/**
 * A probe over an explicit file set — every path the resolver may consult is
 * declared, so a resolution that "works" by accident of the real filesystem
 * cannot pass.
 */
function probeFor(
  files: string[],
  directories: Record<string, string[]> = {}
): LayoutProbe {
  return {
    exists: (candidate) => files.includes(candidate),
    listDir: (candidate) => directories[candidate] ?? [],
  };
}

const storeListing = {
  [PNPM_STORE]: [PNPM_CLI_DIR, PNPM_ENGINE_DIR, "zod@4.3.6"],
  [`${PNPM_STORE}/${PNPM_ENGINE_DIR}/node_modules/@prisma/engines`]: [
    "dist",
    "schema-engine-debian-openssl-3.0.x",
    "package.json",
  ],
};

const fullBundle = () =>
  probeFor(
    [CONFIG_FILE, RESOLVER_FILE, SCHEMA_FILE, MIGRATIONS_DIR, CLI_ENTRY],
    storeListing
  );

// The resolver reads `PRISMA_CLI_ENTRY` from the real env by default, and an
// inherited one changes which entrypoint it adopts. Clearing it keeps every
// case that does not set one explicitly on the bundled-lookup branch.
beforeEach(() => {
  vi.stubEnv(PRISMA_CLI_ENTRY_ENV, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("prisma runtime layout resolution", () => {
  it("walks up from the working directory to the bundle root", () => {
    const roots = candidateRoots(WORKING_DIRECTORY);

    expect(roots[0]).toBe(WORKING_DIRECTORY);
    expect(roots).toContain(BUNDLE_ROOT);
  });

  it("resolves the config dir, CLI entrypoint and native engine from the bundle root", () => {
    const result = resolveMigrateRuntimeLayout(WORKING_DIRECTORY, fullBundle());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.layout.root).toBe(BUNDLE_ROOT);
    expect(result.layout.configDir).toBe(
      `${BUNDLE_ROOT}/packages/database/prisma-runtime`
    );
    expect(result.layout.cliEntry).toBe(CLI_ENTRY);
    expect(result.layout.schemaEngineBinary).toBe(ENGINE_BINARY);
    expect(result.layout.esmResolverEntry).toBe(RESOLVER_FILE);
    expect(result.layout.migrationsDir).toBe(MIGRATIONS_DIR);
  });

  /*
   * ISS-6810, the shipped defect. The pipeline's own readers (pre-stamp,
   * at-head probe, plain-index build, ownership preflight) open
   * `prisma/migrations` themselves, off `process.cwd()` unless told otherwise;
   * a function's cwd is `apps/api`, so the first real preview ensure died in
   * the pre-stamp with ENOENT under `/var/task/apps/api/prisma/migrations`. The
   * layout names the traced directory and refuses a bundle without it, since
   * the CLI could migrate while every in-process reader still fails.
   */
  it("fails rather than resolving a root that carries the schema but no migrations directory", () => {
    const result = resolveMigrateRuntimeLayout(
      WORKING_DIRECTORY,
      probeFor(
        [CONFIG_FILE, RESOLVER_FILE, SCHEMA_FILE, CLI_ENTRY],
        storeListing
      )
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("migrations directory");
  });

  /*
   * ISS-6781. The resolver is a precondition of the spawn like the config is:
   * without it the CLI starts, resolves its `require`s through NODE_PATH, and
   * dies in its config loader on the first ES-module import. Failing here
   * names the missing file instead of shipping that spawn.
   */
  it("fails rather than resolving a root that carries the config but no ESM store resolver", () => {
    const result = resolveMigrateRuntimeLayout(
      WORKING_DIRECTORY,
      probeFor([CONFIG_FILE, SCHEMA_FILE, CLI_ENTRY], storeListing)
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("ESM store resolver");
  });

  /*
   * ISS-6403, the shipped defect. This is the bundle stage actually had: the
   * `.bin` shim present, the entrypoint it forwards to absent. The resolver
   * called that layout resolvable, so `migrate deploy` spawned and died
   * MODULE_NOT_FOUND, and stage `public` silently stopped advancing.
   *
   * Reverting `findCliEntry` to probe for a file named `prisma` in a bin dir
   * turns this red — which is the whole point of it.
   */
  it("fails on a bundle carrying only the bin shim, not the CLI entrypoint", () => {
    const result = resolveMigrateRuntimeLayout(
      WORKING_DIRECTORY,
      probeFor(
        [CONFIG_FILE, RESOLVER_FILE, SCHEMA_FILE, BIN_SHIM],
        storeListing
      )
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("build/index.js");
  });

  it("falls back to a hoisted install when the pnpm store is absent", () => {
    const hoistedEntry = `${BUNDLE_ROOT}/node_modules/prisma/build/index.js`;
    const result = resolveMigrateRuntimeLayout(
      WORKING_DIRECTORY,
      probeFor([
        CONFIG_FILE,
        RESOLVER_FILE,
        SCHEMA_FILE,
        MIGRATIONS_DIR,
        hoistedEntry,
      ])
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.layout.cliEntry).toBe(hoistedEntry);
  });

  it("reports the roots it tried when the CLI was never traced in", () => {
    const result = resolveMigrateRuntimeLayout(
      WORKING_DIRECTORY,
      probeFor([CONFIG_FILE, RESOLVER_FILE, SCHEMA_FILE, MIGRATIONS_DIR])
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.rootsTried).toContain(BUNDLE_ROOT);
    expect(result.reason).toContain("outputFileTracingIncludes");
  });

  it("fails rather than resolving a root that carries the CLI but no schema", () => {
    const result = resolveMigrateRuntimeLayout(
      WORKING_DIRECTORY,
      probeFor([CONFIG_FILE, RESOLVER_FILE, CLI_ENTRY], storeListing)
    );

    expect(result.ok).toBe(false);
  });

  /*
   * The override is the value the pipeline actually spawns, so it is the value
   * that has to be probed. Validating `layout.cliEntry` and then letting an
   * inherited `PRISMA_CLI_ENTRY` win meant the precondition passed on a path
   * nothing had checked — the same unchecked-precondition shape ISS-6403 fixed
   * for the `.bin` shim.
   */
  it("rejects an operator entrypoint override that is not present", () => {
    const result = resolveMigrateRuntimeLayout(
      WORKING_DIRECTORY,
      fullBundle(),
      { [PRISMA_CLI_ENTRY_ENV]: "/opt/stale/prisma/build/index.js" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain(PRISMA_CLI_ENTRY_ENV);
    expect(result.reason).toContain("/opt/stale/prisma/build/index.js");
  });

  it("adopts an operator entrypoint override once it has been probed", () => {
    const override = "/opt/custom/prisma/build/index.js";
    const result = resolveMigrateRuntimeLayout(
      WORKING_DIRECTORY,
      probeFor(
        [CONFIG_FILE, RESOLVER_FILE, SCHEMA_FILE, MIGRATIONS_DIR, override],
        storeListing
      ),
      { [PRISMA_CLI_ENTRY_ENV]: override }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.layout.cliEntry).toBe(override);
  });

  it("treats a whitespace-only override as no override at all", () => {
    const result = resolveMigrateRuntimeLayout(
      WORKING_DIRECTORY,
      fullBundle(),
      {
        [PRISMA_CLI_ENTRY_ENV]: "   ",
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.layout.cliEntry).toBe(CLI_ENTRY);
  });

  /*
   * Two Prisma versions in one store — a peer variant, or a bump mid-flight.
   * Both lookups prefix-match and used to take their own first hit, so the
   * store listing below (the newer engine first) paired the 7.8.0 CLI with the
   * 8.1.0 engine while every `exists` probe still passed.
   */
  it("pairs the engine with the SAME Prisma version as the chosen CLI", () => {
    const otherCliDir = "prisma@8.1.0_@types+react@19.2.17";
    const otherEngineDir = "@prisma+engines@8.1.0";
    const engineListing = [
      "dist",
      "schema-engine-debian-openssl-3.0.x",
      "package.json",
    ];
    const result = resolveMigrateRuntimeLayout(
      WORKING_DIRECTORY,
      probeFor(
        [CONFIG_FILE, RESOLVER_FILE, SCHEMA_FILE, MIGRATIONS_DIR, CLI_ENTRY],
        {
          [PNPM_STORE]: [
            otherEngineDir,
            PNPM_CLI_DIR,
            PNPM_ENGINE_DIR,
            otherCliDir,
          ],
          [`${PNPM_STORE}/${PNPM_ENGINE_DIR}/node_modules/@prisma/engines`]:
            engineListing,
          [`${PNPM_STORE}/${otherEngineDir}/node_modules/@prisma/engines`]:
            engineListing,
        }
      ),
      {}
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.layout.cliEntry).toBe(CLI_ENTRY);
    expect(result.layout.schemaEngineBinary).toBe(ENGINE_BINARY);
  });

  it("resolves without an engine binary rather than failing the whole layout", () => {
    const result = resolveMigrateRuntimeLayout(
      WORKING_DIRECTORY,
      probeFor(
        [CONFIG_FILE, RESOLVER_FILE, SCHEMA_FILE, MIGRATIONS_DIR, CLI_ENTRY],
        {
          [PNPM_STORE]: [PNPM_CLI_DIR],
        }
      )
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.layout.schemaEngineBinary).toBeNull();
  });
});

describe("applying the prisma runtime layout", () => {
  const layout = {
    root: BUNDLE_ROOT,
    configDir: `${BUNDLE_ROOT}/packages/database/prisma-runtime`,
    esmResolverEntry: RESOLVER_FILE,
    migrationsDir: MIGRATIONS_DIR,
    cliEntry: CLI_ENTRY,
    schemaEngineBinary: `${BUNDLE_ROOT}/engines/schema-engine-linux`,
    modulePaths: [
      `${PNPM_STORE}/${PNPM_CLI_DIR}/node_modules`,
      `${BUNDLE_ROOT}/node_modules`,
    ],
  };

  it("exports the CLI entrypoint and engine", () => {
    const proc = fakeProcess({}, "/var/task/apps/api");

    applyMigrateRuntimeLayout(layout, proc);

    expect(proc.env[PRISMA_CLI_ENTRY_ENV]).toBe(layout.cliEntry);
    expect(proc.env.PRISMA_SCHEMA_ENGINE_BINARY).toBe(
      layout.schemaEngineBinary
    );
  });

  it("NEVER publishes the config directory or the resolver to the environment", () => {
    // review: shafty023. The config directory belongs to ONE ensure run; a
    // `PRISMA_CLI_CWD` env var is process-global reach one indirection past the
    // `chdir` below, and the shared pipeline is read by every build and
    // migrator caller. It travels as a per-invocation `prismaCli.cwd` option on
    // the pipeline call instead -- see the ensure service. ISS-6781: the ESM
    // resolver preload takes the same seam, and NOT `NODE_OPTIONS`, which every
    // child of this process would inherit.
    const proc = fakeProcess({}, "/var/task/apps/api");

    applyMigrateRuntimeLayout(layout, proc);

    expect(proc.env.PRISMA_CLI_CWD).toBeUndefined();
    expect(proc.env.NODE_OPTIONS).toBeUndefined();
    expect(Object.values(proc.env).join("\n")).not.toContain(
      "esm-store-resolver"
    );
  });

  /*
   * ISS-6403 Finding 5. This used to `proc.chdir(layout.configDir)`, and the
   * test above used to assert that it did. A serverless function is a
   * long-lived process serving many requests, several concurrently, so that
   * one call moved the working directory of every OTHER request on the warm
   * instance for the rest of its life -- and nothing ever put it back.
   * Idempotence was never the property that mattered; isolation was.
   */
  it("NEVER moves this process's working directory", () => {
    const proc = fakeProcess({}, "/var/task/apps/api");

    applyMigrateRuntimeLayout(layout, proc);

    expect(proc.chdir).not.toHaveBeenCalled();
    expect(proc.cwd()).toBe("/var/task/apps/api");
  });

  it("is idempotent across warm invocations", () => {
    const proc = fakeProcess({}, "/var/task/apps/api");

    applyMigrateRuntimeLayout(layout, proc);
    applyMigrateRuntimeLayout(layout, proc);

    expect(proc.env[PRISMA_CLI_ENTRY_ENV]).toBe(layout.cliEntry);
    expect(proc.chdir).not.toHaveBeenCalled();
  });

  it("never overwrites an operator-set engine binary", () => {
    const proc = fakeProcess(
      { PRISMA_SCHEMA_ENGINE_BINARY: "/opt/custom-engine" },
      "/var/task/apps/api"
    );

    applyMigrateRuntimeLayout(layout, proc);

    expect(proc.env.PRISMA_SCHEMA_ENGINE_BINARY).toBe("/opt/custom-engine");
  });

  /*
   * ISS-6728. This block used to assert, in the same test as the engine binary
   * above, that an already-set NODE_PATH was left alone -- read at the time as
   * deferring to an operator. It is a CORRECTED EXPECTATION, not a weakened
   * one: the only party that actually sets NODE_PATH on a Vercel function is
   * AWS Lambda, which pre-sets it on every invocation. So the old guard fired
   * on 100% of production requests and 0% of local ones, the store directories
   * reached no spawn, and every `migrate-public` run died in module resolution
   * with `Cannot find module '@prisma/engines'` before the CLI ran at all.
   * Unlike the engine binary, NODE_PATH is a SEARCH PATH -- there is a correct
   * answer that keeps both sides, and deference to a value nobody chose was
   * costing the platform its migrations.
   */
  const LAMBDA_NODE_PATH =
    "/opt/nodejs/node20/node_modules:/opt/nodejs/node_modules:/var/runtime/node_modules:/var/task";

  it("prepends the store directories to a Lambda-preset NODE_PATH", () => {
    const proc = fakeProcess(
      { NODE_PATH: LAMBDA_NODE_PATH },
      "/var/task/apps/api"
    );

    applyMigrateRuntimeLayout(layout, proc);

    expect(proc.env.NODE_PATH).toBe(
      [...layout.modulePaths, LAMBDA_NODE_PATH].join(path.delimiter)
    );
  });

  /*
   * The constraint the merge is most likely to break. A warm Fluid Compute
   * instance serves many ensure requests from ONE process, so a plain prepend
   * would append the store directories again on every request until NODE_PATH
   * grew without bound. Applying twice must write the identical string.
   */
  it("does not grow a Lambda-preset NODE_PATH across warm invocations", () => {
    const proc = fakeProcess(
      { NODE_PATH: LAMBDA_NODE_PATH },
      "/var/task/apps/api"
    );

    applyMigrateRuntimeLayout(layout, proc);
    const afterFirst = proc.env.NODE_PATH;
    applyMigrateRuntimeLayout(layout, proc);
    applyMigrateRuntimeLayout(layout, proc);

    expect(proc.env.NODE_PATH).toBe(afterFirst);
    expect(
      proc.env.NODE_PATH?.split(path.delimiter).filter(
        (entry) => entry === layout.modulePaths[0]
      )
    ).toHaveLength(1);
  });

  /*
   * A deliberate behavior change, not a weakened expectation: the entrypoint
   * override is now adopted and PROBED by `resolveMigrateRuntimeLayout`, so
   * `layout.cliEntry` already IS the operator's value whenever they set a valid
   * one. Declining the write here is what previously let an unprobed value be
   * the thing that ran.
   */
  it("writes the validated entrypoint over an unvalidated inherited one", () => {
    const proc = fakeProcess(
      { PRISMA_CLI_ENTRY: "/opt/stale/prisma/build/index.js" },
      "/var/task/apps/api"
    );

    applyMigrateRuntimeLayout(layout, proc);

    expect(proc.env[PRISMA_CLI_ENTRY_ENV]).toBe(layout.cliEntry);
  });

  it("hands the spawned CLI every store directory as a NODE_PATH entry", () => {
    const proc = fakeProcess({}, "/var/task/apps/api");

    applyMigrateRuntimeLayout(layout, proc);

    expect(proc.env.NODE_PATH).toBe(layout.modulePaths.join(path.delimiter));
  });
});

/**
 * The ISS-6403 thread wongk left open: the entrypoint being PRESENT is not the
 * CLI being RUNNABLE. This starts a real `node` on a real entrypoint laid out
 * the way Next tracing lays one out — physical package directories under
 * `.pnpm/<store entry>/node_modules/<name>`, and NOT ONE of the pnpm symlinks
 * that normally connect them — and asserts it gets past module resolution.
 *
 * The stand-in entrypoint makes the same shape of calls the real CLI does: a
 * bare `require` of a sibling store entry (`@prisma/config`, `@prisma/engines`)
 * and, from inside that one, a bare `require` of ITS own sibling (`c12`). Depth
 * is the point — the failure this covers is a resolution walk that finds
 * nothing, at any level.
 */
describe("running the bundled CLI out of a traced layout", () => {
  const bundle = mkdtempSync(path.join(tmpdir(), "prisma-traced-bundle-"));
  const store = path.join(bundle, "node_modules", ".pnpm");

  function writeStorePackage(
    storeEntry: string,
    packageName: string,
    files: Record<string, string>,
    manifest: Record<string, unknown> = {}
  ) {
    const packageDir = path.join(
      store,
      storeEntry,
      "node_modules",
      ...packageName.split("/")
    );
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: packageName,
        main: "index.js",
        version: "0.0.0",
        ...manifest,
      })
    );
    for (const [name, contents] of Object.entries(files)) {
      const filePath = path.join(packageDir, name);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, contents);
    }
  }

  const configDir = path.join(bundle, "packages", "database", "prisma-runtime");
  const schemaDir = path.join(bundle, "packages", "database", "prisma");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "prisma.config.mjs"),
    "export default {};"
  );
  writeFileSync(path.join(schemaDir, "schema.prisma"), "// schema");
  mkdirSync(path.join(schemaDir, "migrations"), { recursive: true });
  // The REAL resolver, exactly as the tracing glob places it beside the config —
  // it is the code under test, not a stand-in for it.
  for (const resolverFile of ESM_RESOLVER_FILES) {
    copyFileSync(
      path.join(REAL_RUNTIME_CONFIG_DIR, resolverFile),
      path.join(configDir, resolverFile)
    );
  }

  /*
   * The stand-in CLI. With no args it only proves module resolution, which is
   * what the first test below needs. Given real `migrate` args it also ACTS
   * like the CLI: it reports its own cwd, fails the first `migrate deploy` with
   * a P3009, accepts the rolled-back resolve, and succeeds on the retry — so
   * the second test can drive the real exported pipeline end to end (review:
   * shafty023). State lives in a file because each step is a separate process.
   *
   * ISS-6781: it also loads its config the way the real CLI does — a CommonJS
   * `require("@prisma/config")` that `import()`s the ES-module `c12`, which
   * `import`s a NAMED export from `jiti`. That chain is where production died,
   * and it is what the resolver preload exists for; the CLI prints what `c12`
   * resolved so the test can tell WHICH `jiti` it got.
   */
  writeStorePackage("prisma@7.8.0_@types+react@19.2.17", "prisma", {
    "build/index.js": [
      'require("@prisma/engines");',
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      "function run(config) {",
      '  process.stdout.write("prisma-cli-started config=" + config);',
      "  if (args.length === 0) { process.exit(0); }",
      '  process.stdout.write("\\ncwd=" + process.cwd() + "\\n");',
      "  const stateFile = process.env.STANDIN_STATE_FILE;",
      '  const seen = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : "";',
      '  if (args[1] === "deploy") {',
      '    if (seen === "") {',
      '      fs.writeFileSync(stateFile, "deploy-1");',
      '      process.stderr.write("Error: P3009\\nMigration name: 20260101000000_add_widget\\n");',
      "      process.exit(1);",
      "    }",
      '    fs.appendFileSync(stateFile, "|deploy-2");',
      '    process.stdout.write("1 migration applied\\n");',
      "    process.exit(0);",
      "  }",
      '  if (args[1] === "resolve") {',
      '    fs.appendFileSync(stateFile, "|resolved:" + args[3]);',
      '    process.stdout.write("rolled back\\n");',
      "    process.exit(0);",
      "  }",
      "  process.exit(0);",
      "}",
      'require("@prisma/config").loadConfig().then(run, (error) => {',
      '  process.stderr.write("Unknown error during config file loading: " + error);',
      "  process.exit(1);",
      "});",
    ].join("\n"),
  });
  writeStorePackage("@prisma+config@7.8.0", "@prisma/config", {
    "index.js":
      'module.exports = { loadConfig: () => import("c12").then((c12) => c12.loadConfig()) };',
  });
  writeStorePackage("@prisma+engines@7.8.0", "@prisma/engines", {
    "index.js": "module.exports = {};",
    "schema-engine-debian-openssl-3.0.x": "#!/bin/sh\n",
  });
  writeStorePackage(
    "c12@3.3.3",
    "c12",
    {
      "index.js":
        'import { createJiti } from "jiti";\nexport const loadConfig = () => createJiti();',
    },
    { type: "module", dependencies: { jiti: "^2.0.0" } }
  );
  // The `jiti` c12 depends on, ESM with the named export …
  writeStorePackage(
    "jiti@2.0.0",
    "jiti",
    { "index.js": 'export const createJiti = () => "jiti@2";' },
    { type: "module", version: "2.0.0" }
  );
  // … and the OTHER `jiti` the store also carries: CommonJS, no named export.
  writeStorePackage(
    "jiti@1.21.7",
    "jiti",
    { "index.js": "module.exports = function jiti() {};" },
    { version: "1.21.7" }
  );
  // Production's shape (ISS-6781): the bundle has no sibling symlink from c12
  // to ITS jiti, but node's walk-up does reach hoisted copies — `c12` itself,
  // and a `jiti` that is the wrong one. Without the resolver, that is the copy
  // the named import hits.
  const hoisted = path.join(store, "node_modules");
  mkdirSync(hoisted, { recursive: true });
  symlinkSync(
    path.join("..", "c12@3.3.3", "node_modules", "c12"),
    path.join(hoisted, "c12"),
    "dir"
  );
  symlinkSync(
    path.join("..", "jiti@1.21.7", "node_modules", "jiti"),
    path.join(hoisted, "jiti"),
    "dir"
  );

  afterAll(() => {
    rmSync(bundle, { force: true, recursive: true });
  });

  it("starts the CLI entrypoint without a MODULE_NOT_FOUND", () => {
    const result = resolveMigrateRuntimeLayout(
      path.join(bundle, "apps", "api", ".next", "server")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // The spawn env is built the way production builds it: the layout applied
    // to the function's process, which `runMigrationPipeline` then spreads into
    // `spawnSync`. Asserting on a hand-built env would prove nothing about it.
    const proc = fakeProcess({}, bundle);
    applyMigrateRuntimeLayout(result.layout, proc);

    const spawned = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(result.layout.esmResolverEntry).href,
        result.layout.cliEntry,
      ],
      {
        encoding: "utf8",
        env: proc.env,
        timeout: 30_000,
      }
    );

    expect(spawned.error).toBeUndefined();
    expect(spawned.stderr).not.toContain("MODULE_NOT_FOUND");
    expect(spawned.stdout).toContain("prisma-cli-started config=jiti@2");
    expect(spawned.status).toBe(0);
  });

  /*
   * ISS-6781, the shipped defect, reproduced on the fixture above: the same
   * spawn WITHOUT the resolver preload. `NODE_PATH` still resolves every
   * `require`, so the CLI starts — and its config loader's ES-module import of
   * `jiti` walks up to the hoisted CommonJS copy and fails on the named export
   * with the exact message stage logged. This is what proves the case above
   * passes because of the resolver and not because the fixture is easy.
   */
  it("reproduces the ISS-6781 config-loader failure when the resolver is not preloaded", () => {
    const result = resolveMigrateRuntimeLayout(
      path.join(bundle, "apps", "api", ".next", "server")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const proc = fakeProcess({}, bundle);
    applyMigrateRuntimeLayout(result.layout, proc);

    const spawned = spawnSync(process.execPath, [result.layout.cliEntry], {
      encoding: "utf8",
      env: proc.env,
      timeout: 30_000,
    });

    expect(spawned.status).toBe(1);
    expect(spawned.stderr).toContain(
      "Unknown error during config file loading"
    );
    expect(spawned.stderr).toContain("Named export 'createJiti' not found");
    expect(spawned.stderr).toContain("is a CommonJS module");
    expect(spawned.stdout).not.toContain("prisma-cli-started");
  });

  /*
   * review: shafty023. The test above spawns the entrypoint DIRECTLY, so it
   * proves module resolution and nothing else — a broken real async launch, a
   * config directory that never reaches the child, a lost stream drain or a
   * recovery spawn that cannot run would all keep it green, and the sibling
   * `migration-pipeline-prisma-cli.test.ts` only ever sees a MOCKED `spawn`.
   *
   * This one drives the REAL exported `runMigrateWithRetry` against the same
   * stand-in, over real child processes, through the whole chain: deploy →
   * P3009 → `migrate resolve --rolled-back` → deploy retry. Every step is
   * asserted from what the children actually did (their cwd, their forwarded
   * output, the order they ran in), not from a mock's call log.
   */
  it("runs the real pipeline over real children: cwd, output, resolve/retry", async () => {
    const result = resolveMigrateRuntimeLayout(
      path.join(bundle, "apps", "api", ".next", "server")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // The env is built exactly the way production builds it — the resolved
    // layout applied to the process the pipeline runs in.
    const proc = fakeProcess({}, bundle);
    applyMigrateRuntimeLayout(result.layout, proc);
    vi.stubEnv(PRISMA_CLI_ENTRY_ENV, proc.env[PRISMA_CLI_ENTRY_ENV]);
    vi.stubEnv("NODE_PATH", proc.env.NODE_PATH);
    const stateFile = path.join(bundle, "standin-state");
    vi.stubEnv("STANDIN_STATE_FILE", stateFile);
    // The children are bare `node` processes whose cwd and NODE_PATH reach only
    // this synthetic bundle. CI runs Vitest under
    // `NODE_OPTIONS=-r dd-trace/ci/init --import dd-trace/register.js` (Datadog
    // Test Optimization), and `runPrismaCli` spreads `process.env` into the
    // child — so node would resolve that preload from the bundle, fail with
    // MODULE_NOT_FOUND and exit 1 before the stand-in CLI ever ran. Cleared for
    // the children, not for this process, which already read it at startup.
    vi.stubEnv("NODE_OPTIONS", "");

    const forwarded: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        forwarded.push(String(chunk));
        return true;
      });

    let didReset: boolean;
    try {
      didReset = await runMigrateWithRetry(
        "postgresql://user:placeholder@example.com:5432/cl",
        // Non-preview, so the P3009 takes the resolve/retry path rather than a
        // schema reset — the branch that needs no database of its own.
        "public",
        undefined,
        undefined,
        {},
        // The per-invocation options under test: these, and nothing on the
        // environment, are what put the child in the config directory and
        // preload the ESM store resolver into it.
        {
          cwd: result.layout.configDir,
          preload: result.layout.esmResolverEntry,
        }
      );
    } finally {
      stdoutSpy.mockRestore();
    }

    // The chain completed without a reset, over three real child processes.
    expect(didReset).toBe(false);
    expect(readFileSync(stateFile, "utf8")).toBe(
      "deploy-1|resolved:20260101000000_add_widget|deploy-2"
    );

    // The children ran where Prisma 7 discovers `prisma.config.mjs`, and their
    // output survived the async drain to reach this process's stdout.
    const output = forwarded.join("");
    // EVERY child, not "at least one". The recovery spawn is a separate call
    // site from the deploy, so binding the option into only one of them leaves
    // the two deploys correct and the resolve running from wherever this
    // process happens to be — which a `toContain` on one directory cannot see.
    // `realpathSync` because macOS resolves the tmpdir's /var -> /private/var
    // symlink in the CHILD's own `process.cwd()`; the directory is the same one.
    const childCwds = [...output.matchAll(/^cwd=(.+)$/gm)].map(
      (match) => match[1]
    );
    const configDir = realpathSync(result.layout.configDir);
    expect(childCwds).toEqual([configDir, configDir, configDir]);
    // ISS-6781: EVERY child loaded its config through the resolver — the
    // `jiti` c12 declares, not the hoisted CommonJS one the walk-up finds. The
    // recovery spawn is again a separate call site, so a preload bound into
    // only the deploy would leave the resolve dying in its config loader.
    expect(output.match(/config=jiti@2/g)).toHaveLength(3);
    expect(output).toContain("rolled back");
    expect(output).toContain("1 migration applied");
    // The failing first deploy still resolved through module resolution, so a
    // MODULE_NOT_FOUND cannot masquerade as the P3009 this asserts on.
    expect(output).not.toContain("MODULE_NOT_FOUND");
    expect(output).not.toContain("Unknown error during config file loading");
  }, 60_000);
});

function fakeProcess(
  overrides: {
    PRISMA_CLI_ENTRY?: string;
    PRISMA_SCHEMA_ENGINE_BINARY?: string;
    NODE_PATH?: string;
  },
  cwd: string
) {
  // `next` augments ProcessEnv with a required NODE_ENV, so the fake carries
  // one rather than being cast into shape.
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", ...overrides };
  let current = cwd;
  return {
    env,
    cwd: () => current,
    chdir: vi.fn((next: string) => {
      current = next;
    }),
  };
}
