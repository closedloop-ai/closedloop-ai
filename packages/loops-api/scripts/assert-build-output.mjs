// Post-build completeness guard for @closedloop-ai/loops-api (FEA-1795).
//
// tsup emits declarations (`dist/*.d.ts`) via a worker; under CI load that pass
// is non-deterministic. Two failure modes have been seen: (1) it can exit 0 with
// no/empty `.d.ts` (JS-only dist), and (2) it can exit 0 with a `.d.ts` that is
// present and non-empty but has silently dropped some exports (e.g. `export type`
// aliases while keeping the runtime `*Schema` consts). Consumers resolve loops-api
// types exclusively from `dist/*.d.ts` (the `exports` map's `types` condition; no
// `src` path-alias fallback), so either case typechecks locally yet breaks a fresh
// consumer `typecheck` — and turbo would cache that partial artifact.
//
// This guard runs two checks and exits non-zero on any problem, so turbo never
// caches an incomplete build:
//   1. Presence — every `dist/` file referenced by the `exports` map exists, is
//      non-empty, and every `.d.ts` contains exports.
//   2. Completeness — every name a source entry exports is also exported by its
//      emitted `dist/*.d.ts` (catches the silent partial-DTS case). This uses the
//      TypeScript compiler to resolve exports (including `export *` re-exports) on
//      both sides, so it is robust to declaration bundling.

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");

export function findBuildOutputProblems({
  packageDir: dir,
  exportsMap,
  readFile,
  statSize,
}) {
  const problems = [];
  for (const relativePath of collectDistPaths(exportsMap)) {
    const absolutePath = join(dir, relativePath);
    const size = statSize(absolutePath);
    if (size === null || size === undefined || size === 0) {
      problems.push(`${relativePath}: missing or empty`);
      continue;
    }
    if (
      relativePath.endsWith(".d.ts") &&
      !readFile(absolutePath).includes("export")
    ) {
      problems.push(
        `${relativePath}: declaration file has no exports (incomplete DTS)`
      );
    }
  }
  return problems;
}

export function findMissingExportProblems(expectedByEntry, actualByEntry) {
  const problems = [];
  for (const [entry, expectedNames] of Object.entries(expectedByEntry)) {
    const actualNames = new Set(actualByEntry[entry] ?? []);
    const missing = expectedNames.filter((name) => !actualNames.has(name));
    if (missing.length > 0) {
      problems.push(
        `${entry}: declaration is missing exported member(s): ${[...missing].sort().join(", ")}`
      );
    }
  }
  return problems;
}

function collectDistPaths(exportsMap) {
  const paths = new Set();
  collectDistStrings(exportsMap, paths);
  return [...paths];
}

// Walk every value in the exports map — including nested condition objects and
// arrays — and collect each "./dist/..." string leaf. The guard exists to fail
// loud on an incomplete dist/; silently skipping a shape it does not recognize
// (e.g. an entry that nests `types`/`default` under `import`/`require`) would
// quietly turn it back into a no-op for that entry. Recursing keeps it correct
// for both the flat conditions loops-api uses today and any future nesting.
function collectDistStrings(node, paths) {
  if (typeof node === "string") {
    if (node.startsWith("./dist/")) {
      paths.add(node.slice(2));
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) {
      collectDistStrings(value, paths);
    }
  }
}

function safeStatSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

// Map each exports-map subpath to its declaration file and the source entry it
// is built from (dist/<base>.d.ts <- src/<base>.ts), so completeness can compare
// the two. Only the `types` condition is consulted — that is the contract
// consumers resolve and the field the partial-DTS bug corrupts.
function resolveDeclarationEntries(exportsMap) {
  const entries = [];
  for (const entry of Object.values(exportsMap)) {
    const types = entry && typeof entry === "object" ? entry.types : null;
    if (
      typeof types === "string" &&
      types.startsWith("./dist/") &&
      types.endsWith(".d.ts")
    ) {
      const base = types.slice("./dist/".length, -".d.ts".length);
      entries.push({
        distDts: join("dist", `${base}.d.ts`),
        src: join("src", `${base}.ts`),
      });
    }
  }
  return entries;
}

// Resolve the full set of exported names for each module via the TypeScript
// checker (resolves `export *` / re-exports). Type errors do not matter — only
// the export symbol table is read — so skipLibCheck keeps it fast.
function collectModuleExports(absoluteFiles) {
  const program = ts.createProgram(absoluteFiles, {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
    allowJs: false,
  });
  const checker = program.getTypeChecker();
  const exportsByFile = new Map();
  for (const file of absoluteFiles) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) {
      exportsByFile.set(file, null);
      continue;
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    exportsByFile.set(
      file,
      moduleSymbol
        ? checker
            .getExportsOfModule(moduleSymbol)
            .map((symbol) => symbol.getName())
        : []
    );
  }
  return exportsByFile;
}

function checkExportCompleteness(exportsMap) {
  const entries = resolveDeclarationEntries(exportsMap);
  const srcExports = collectModuleExports(
    entries.map((entry) => join(packageDir, entry.src))
  );
  const distExports = collectModuleExports(
    entries.map((entry) => join(packageDir, entry.distDts))
  );
  const expectedByEntry = {};
  const actualByEntry = {};
  for (const entry of entries) {
    const expected = srcExports.get(join(packageDir, entry.src));
    if (expected == null) {
      continue;
    }
    expectedByEntry[entry.distDts] = expected;
    actualByEntry[entry.distDts] =
      distExports.get(join(packageDir, entry.distDts)) ?? [];
  }
  return findMissingExportProblems(expectedByEntry, actualByEntry);
}

function runCli() {
  const packageJson = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8")
  );
  const exportsMap = packageJson.exports ?? {};

  const problems = findBuildOutputProblems({
    packageDir,
    exportsMap,
    readFile: (path) => readFileSync(path, "utf8"),
    statSize: safeStatSize,
  });

  // Completeness needs the build outputs to exist; only run it when presence
  // passed. This check fails CLOSED: if it cannot run (e.g. the compiler API
  // throws under CI memory pressure), that is recorded as a problem so the build
  // fails and turbo never caches a dist/ we could not certify as complete.
  // Failing open here defeats the guard's purpose — the completeness check and
  // a partial-DTS emit share the same trigger (CI load), so an open failure
  // tends to coincide with exactly the artifact this guard exists to reject.
  if (problems.length === 0) {
    try {
      problems.push(...checkExportCompleteness(exportsMap));
    } catch (error) {
      problems.push(
        `declaration-completeness check could not run (${error.message}); refusing to certify dist/ as complete`
      );
    }
  }

  if (problems.length > 0) {
    console.error("loops-api build output check failed — dist/ is incomplete:");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error(
      "Refusing a zero exit so turbo will not cache this partial artifact."
    );
    process.exitCode = 1;
    return;
  }

  const verified = collectDistPaths(exportsMap).length;
  console.log(
    `✔ loops-api build output complete: ${verified} files verified, declaration exports match source`
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  runCli();
}
