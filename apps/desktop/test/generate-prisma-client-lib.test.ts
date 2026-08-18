/**
 * ISS-5303 — `generate-prisma-client-lib.mjs`, the skip decision behind
 * `pnpm db:generate`.
 *
 * This is a cache, and a cache that answers "fresh" when it is not silently
 * ships a stale Prisma client into a dev launch, a packaged build, or CI. Both
 * halves are therefore driven directly: the fingerprint must move when ANY input
 * moves (bytes or path), and the freshness check must fail closed on every
 * uncertainty — no fingerprint file, a mismatched one, or any single required
 * output missing.
 *
 * The last two cases drive `generate-prisma-client.mjs` itself as a subprocess.
 * One runs the real entrypoint source in a synthetic repo with a stub `pnpm`, so
 * BOTH branches (generate, then skip) are exercised deterministically without
 * touching the real generated client; the other checks the real entrypoint, at
 * its real paths, agrees with the lib about the real tree.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  inputFingerprint,
  isGeneratedClientFresh,
} from "../scripts/generate-prisma-client-lib.mjs";

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(DESKTOP_DIR, "..", "..");
const ENTRYPOINT_NAME = "generate-prisma-client.mjs";
const LIB_NAME = "generate-prisma-client-lib.mjs";
const FINGERPRINT_FILE_NAME = ".prisma-generate-fingerprint";
const UNCHANGED_MESSAGE = "prisma-generate: unchanged\n";

/**
 * The stubbed `pnpm` returns immediately, so anything approaching this is a
 * hang. node:test's own `timeout` cannot interrupt `spawnSync` (it blocks this
 * worker's event loop), so the child carries its own deadline; the per-case
 * budget has to cover EVERY child a case runs, or the case expires before the
 * last child's deadline can report what went wrong.
 */
const SPAWN_TIMEOUT_MS = 30_000;
const SINGLE_CHILD_CASE_TIMEOUT_MS = 60_000;
const THREE_CHILD_CASE_TIMEOUT_MS = 120_000;

// The generated-client files the entrypoint treats as proof that a previous
// `prisma generate` actually completed.
const REQUIRED_OUTPUTS = [
  "client.ts",
  "browser.ts",
  join("internal", "class.ts"),
  join("internal", "prismaNamespace.ts"),
];

// The four inputs `generate-prisma-client.mjs` hashes, restated relative to the
// repo root. This is a deliberate restatement, not a copy of implementation
// detail: the real-tree wiring case below is what proves the entrypoint still
// hashes exactly these, and it goes red if the entrypoint's list drifts.
const REAL_INPUT_RELATIVE_PATHS = [
  join("apps", "desktop", "prisma", "schema.prisma"),
  join("apps", "desktop", "prisma.config.ts"),
  join("apps", "desktop", "package.json"),
  "pnpm-lock.yaml",
];

// A stub `pnpm` that fails loudly instead of generating anything. The real
// entrypoint calls `process.exit(status)` on a non-zero generator, BEFORE it
// writes the fingerprint file — which is what makes it safe to drive the real
// script against the real tree without being able to poison it.
const FAILING_PNPM_STATUS = 7;

function withTempDir(prefix: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

/**
 * Lay down a generated-client directory that satisfies every required output,
 * plus a fingerprint file holding `fingerprintValue` (newline-terminated, the
 * way the entrypoint writes it).
 */
function seedGeneratedClient(
  root: string,
  fingerprintValue: string
): { fingerprintFile: string; generatedDir: string } {
  const generatedDir = join(root, "generated");
  for (const relativePath of REQUIRED_OUTPUTS) {
    writeFile(join(generatedDir, relativePath), "// generated\n");
  }
  const fingerprintFile = join(generatedDir, FINGERPRINT_FILE_NAME);
  writeFile(fingerprintFile, `${fingerprintValue}\n`);
  return { fingerprintFile, generatedDir };
}

/**
 * Build a synthetic repo whose layout matches the one
 * `generate-prisma-client.mjs` derives from `import.meta.url`, and drop the
 * REAL entrypoint and lib sources into it. Reading them off disk is what keeps
 * this from testing a stale transcription of the script.
 */
function stageSyntheticRepo(root: string): {
  appDir: string;
  binDir: string;
  entrypoint: string;
  logFile: string;
  schemaFile: string;
} {
  const appDir = join(root, "apps", "desktop");
  const scriptsDir = join(appDir, "scripts");
  const schemaFile = join(appDir, "prisma", "schema.prisma");

  writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFile(schemaFile, "generator client {\n}\n");
  writeFile(join(appDir, "prisma.config.ts"), "export default {};\n");
  writeFile(join(appDir, "package.json"), '{ "name": "desktop-fixture" }\n');

  const entrypoint = join(scriptsDir, ENTRYPOINT_NAME);
  writeFile(
    entrypoint,
    readFileSync(join(DESKTOP_DIR, "scripts", ENTRYPOINT_NAME), "utf8")
  );
  writeFile(
    join(scriptsDir, LIB_NAME),
    readFileSync(join(DESKTOP_DIR, "scripts", LIB_NAME), "utf8")
  );

  const binDir = join(root, "bin");
  const logFile = join(root, "pnpm-invocations.log");
  writeStubPnpm(binDir, { succeed: true });

  return { appDir, binDir, entrypoint, logFile, schemaFile };
}

/**
 * Write an executable `pnpm` shim. The success variant records its argv and
 * fabricates the generated-client outputs (as the real generator would); the
 * failure variant records its argv and exits non-zero without writing anything.
 */
function writeStubPnpm(binDir: string, options: { succeed: boolean }): void {
  const implementation = join(binDir, "stub-pnpm.cjs");
  const outputs = JSON.stringify(REQUIRED_OUTPUTS);
  const body = options.succeed
    ? `const generated = path.join(process.cwd(), "src", "main", "database", "generated");
for (const relativePath of ${outputs}) {
  const file = path.join(generated, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "// stub generated\\n");
}
`
    : `process.exit(${FAILING_PNPM_STATUS});\n`;

  writeFile(
    implementation,
    `const fs = require("node:fs");
const path = require("node:path");
if (process.env.STUB_PNPM_LOG) {
  fs.appendFileSync(process.env.STUB_PNPM_LOG, process.argv.slice(2).join(" ") + "\\n");
}
${body}`
  );

  const shim = join(binDir, "pnpm");
  writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${implementation}" "$@"\n`
  );
  // The entrypoint resolves `pnpm` through PATH, so the shim has to carry the
  // execute bit or `spawnSync` reports EACCES instead of running it.
  chmodSync(shim, 0o755);
}

function stubInvocationCount(logFile: string): number {
  if (!existsSync(logFile)) {
    return 0;
  }
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).length;
}

function runEntrypoint(
  entrypoint: string,
  env: NodeJS.ProcessEnv
): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [entrypoint], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env,
  });
  if (result.error) {
    // Thrown, not asserted: a launch or deadline failure means the observations
    // below describe nothing, and the caller's assertions would be meaningless.
    throw new Error(
      `entrypoint did not exit on its own: ${result.error.message}`
    );
  }
  return { status: result.status, stdout: result.stdout };
}

describe("ISS-5303: the prisma-generate input fingerprint", () => {
  test("is stable across repeated runs over identical inputs", () => {
    withTempDir("prisma-fingerprint-", (dir) => {
      writeFile(join(dir, "a.txt"), "alpha");
      writeFile(join(dir, "nested", "b.txt"), "beta");
      const inputs = [join(dir, "a.txt"), join(dir, "nested", "b.txt")];

      assert.equal(
        inputFingerprint(inputs, dir),
        inputFingerprint(inputs, dir)
      );
    });
  });

  test("changes when any input's bytes change", () => {
    withTempDir("prisma-fingerprint-", (dir) => {
      writeFile(join(dir, "a.txt"), "alpha");
      writeFile(join(dir, "b.txt"), "beta");
      const inputs = [join(dir, "a.txt"), join(dir, "b.txt")];
      const before = inputFingerprint(inputs, dir);

      writeFile(join(dir, "b.txt"), "beta!");

      assert.notEqual(
        inputFingerprint(inputs, dir),
        before,
        "an edited schema/lockfile must invalidate the cached client"
      );
    });
  });

  test("changes when an input's path changes even though its bytes do not", () => {
    withTempDir("prisma-fingerprint-", (dir) => {
      writeFile(join(dir, "a.txt"), "alpha");
      writeFile(join(dir, "b.txt"), "beta");
      writeFile(join(dir, "renamed.txt"), "beta");

      assert.notEqual(
        inputFingerprint([join(dir, "a.txt"), join(dir, "renamed.txt")], dir),
        inputFingerprint([join(dir, "a.txt"), join(dir, "b.txt")], dir),
        "the path is folded into the hash, so a rename is a change"
      );
    });
  });

  test("is anchored at the repo root, not the absolute checkout location", () => {
    // Two checkouts of the same tree — a worktree, a CI runner, a container —
    // must agree, or every fresh clone pays a spurious `prisma generate`.
    withTempDir("prisma-fingerprint-a-", (first) => {
      withTempDir("prisma-fingerprint-b-", (second) => {
        for (const root of [first, second]) {
          writeFile(join(root, "apps", "desktop", "package.json"), "{}\n");
          writeFile(join(root, "pnpm-lock.yaml"), "lock\n");
        }

        const fingerprintFor = (root: string) =>
          inputFingerprint(
            [
              join(root, "apps", "desktop", "package.json"),
              join(root, "pnpm-lock.yaml"),
            ],
            root
          );

        assert.equal(fingerprintFor(first), fingerprintFor(second));
      });
    });
  });
});

describe("ISS-5303: the generated-client freshness check fails closed", () => {
  test("is false when no fingerprint file was ever written", () => {
    withTempDir("prisma-fresh-", (dir) => {
      const { fingerprintFile, generatedDir } = seedGeneratedClient(
        dir,
        "abc123"
      );
      rmSync(fingerprintFile);

      assert.equal(
        isGeneratedClientFresh({
          fingerprintFile,
          generatedDir,
          requiredOutputs: REQUIRED_OUTPUTS,
          fingerprintValue: "abc123",
        }),
        false
      );
    });
  });

  test("is false when the recorded fingerprint does not match", () => {
    withTempDir("prisma-fresh-", (dir) => {
      const { fingerprintFile, generatedDir } = seedGeneratedClient(
        dir,
        "stale-fingerprint"
      );

      assert.equal(
        isGeneratedClientFresh({
          fingerprintFile,
          generatedDir,
          requiredOutputs: REQUIRED_OUTPUTS,
          fingerprintValue: "abc123",
        }),
        false
      );
    });
  });

  test("is false when any single required output is missing", () => {
    // One case per output, not one case for "some output". A check that only
    // ever looked at `client.ts` would pass a three-of-four test written the
    // lazy way, and a half-written client would be certified fresh.
    for (const missing of REQUIRED_OUTPUTS) {
      withTempDir("prisma-fresh-", (dir) => {
        const { fingerprintFile, generatedDir } = seedGeneratedClient(
          dir,
          "abc123"
        );
        rmSync(join(generatedDir, missing));

        assert.equal(
          isGeneratedClientFresh({
            fingerprintFile,
            generatedDir,
            requiredOutputs: REQUIRED_OUTPUTS,
            fingerprintValue: "abc123",
          }),
          false,
          `a client missing ${missing} must not be reported fresh`
        );
      });
    }
  });

  test("is true only when the fingerprint matches and every output exists", () => {
    withTempDir("prisma-fresh-", (dir) => {
      const { fingerprintFile, generatedDir } = seedGeneratedClient(
        dir,
        "abc123"
      );

      // The entrypoint writes the fingerprint newline-terminated; the check has
      // to tolerate that or `db:generate` never skips anything.
      assert.equal(
        readFileSync(fingerprintFile, "utf8"),
        "abc123\n",
        "fixture must match how the entrypoint writes the fingerprint"
      );
      assert.equal(
        isGeneratedClientFresh({
          fingerprintFile,
          generatedDir,
          requiredOutputs: REQUIRED_OUTPUTS,
          fingerprintValue: "abc123",
        }),
        true
      );
    });
  });
});

describe("ISS-5303: generate-prisma-client.mjs is wired to the lib", () => {
  test("the entrypoint generates once, then skips while the inputs are unchanged", {
    timeout: THREE_CHILD_CASE_TIMEOUT_MS,
  }, () => {
    withTempDir("prisma-entrypoint-", (root) => {
      const { appDir, binDir, entrypoint, logFile, schemaFile } =
        stageSyntheticRepo(root);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        STUB_PNPM_LOG: logFile,
      };
      const fingerprintFile = join(
        appDir,
        "src",
        "main",
        "database",
        "generated",
        FINGERPRINT_FILE_NAME
      );

      const cold = runEntrypoint(entrypoint, env);
      assert.equal(cold.status, 0);
      assert.equal(cold.stdout, "");
      assert.equal(
        stubInvocationCount(logFile),
        1,
        "a cold tree must run the generator"
      );
      assert.equal(
        readFileSync(fingerprintFile, "utf8").trim().length,
        64,
        "the entrypoint must persist the sha256 the lib computed"
      );

      const warm = runEntrypoint(entrypoint, env);
      assert.equal(warm.status, 0);
      assert.equal(warm.stdout, UNCHANGED_MESSAGE);
      assert.equal(
        stubInvocationCount(logFile),
        1,
        "dropping the freshness call would re-run the generator here"
      );

      // Touching a hashed input must break the skip — this is the branch that
      // proves the entrypoint feeds real input bytes into the fingerprint
      // rather than caching on the file's mere existence.
      writeFile(schemaFile, `generator client {\n  provider = "x"\n}\n`);

      const invalidated = runEntrypoint(entrypoint, env);
      assert.equal(invalidated.status, 0);
      assert.equal(invalidated.stdout, "");
      assert.equal(
        stubInvocationCount(logFile),
        2,
        "an edited schema must invalidate the cached client"
      );
    });
  });

  test("the real entrypoint's verdict on the real tree matches the lib's", {
    timeout: SINGLE_CHILD_CASE_TIMEOUT_MS,
  }, () => {
    // Pins the production wiring the synthetic repo above cannot: the actual
    // four hashed inputs, the actual generated-client location, and the actual
    // fingerprint filename. The stub `pnpm` exits non-zero, so the "not fresh"
    // branch cannot write anything into the real tree.
    withTempDir("prisma-real-tree-", (root) => {
      const binDir = join(root, "bin");
      writeStubPnpm(binDir, { succeed: false });

      const generatedDir = join(
        DESKTOP_DIR,
        "src",
        "main",
        "database",
        "generated"
      );
      const expectedFresh = isGeneratedClientFresh({
        fingerprintFile: join(generatedDir, FINGERPRINT_FILE_NAME),
        generatedDir,
        requiredOutputs: REQUIRED_OUTPUTS,
        fingerprintValue: inputFingerprint(
          REAL_INPUT_RELATIVE_PATHS.map((relativePath) =>
            join(REPO_ROOT, relativePath)
          ),
          REPO_ROOT
        ),
      });

      const result = runEntrypoint(
        join(DESKTOP_DIR, "scripts", ENTRYPOINT_NAME),
        {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        }
      );

      assert.equal(
        result.stdout === UNCHANGED_MESSAGE,
        expectedFresh,
        "the entrypoint and the lib disagree about the real generated client"
      );
      assert.equal(result.status, expectedFresh ? 0 : FAILING_PNPM_STATUS);
    });
  });
});
