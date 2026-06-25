#!/usr/bin/env node
/**
 * check-design-system-drift.mjs
 *
 * Parity-drift detector for `@closedloop-ai/design-system` vs the desktop
 * renderer. Reports four signals (one forward, three reverse-direction /
 * usage-fidelity additions).
 *
 * Owners:
 *   - FEA-1516 (PLN-848) — forward direction (exports-not-imported). Substrate.
 *   - FEA-1568 (PLN-867) — inverse + coverage-based + Storybook-based variants.
 *
 * Signals (all reported in the same JSON / Markdown summary):
 *   1. Forward (FEA-1516): design-system exports NOT consumed by the renderer.
 *   2. Inverse (FEA-1568, AC-090.2.d): renderer named imports of design-system
 *      that do NOT resolve to a current export — `tsc` would fail; this just
 *      surfaces it at PR-summary time.
 *   3. Coverage-based (FEA-1568, AC-090.2.b): renderer-imported design-system
 *      exports whose importing renderer file has no executed line in the LCOV
 *      data passed via `--coverage-lcov`. Omitted when the flag is absent.
 *   4. Storybook-based (FEA-1568, AC-090.2.c): Storybook stories under
 *      `--storybook-dir` whose `component:` import does not appear in any
 *      exercised renderer file (per the same LCOV data). Omitted when neither
 *      flag is present, or when the storybook directory is missing.
 *
 * Fidelity caps (apply to all four signals — inverse, coverage-based, and
 * Storybook-based variants inherit the static-scan limitations of FEA-1516):
 *   - Static named-import scan. Does NOT see dynamic imports, namespace imports
 *     (`import * as X`), or barrel-file re-exports.
 *   - Drives the export surface from `packages/design-system/package.json`'s
 *     `exports` map (skipping non-TS entries like CSS / postcss config). Every
 *     public subpath registered in the exports map is scanned for named
 *     exports, including hooks/*, providers/*, lib/* — not just components/ui/.
 *   - Renderer walk skips `*.test.*`, `*.stories.*`, and `*.spec.*` files so
 *     test- or story-only imports do not show up as production consumption.
 *   - Renderer imports of specifiers that are NOT in the exports map (private
 *     subpaths or exports-map gaps) are reported as stderr warnings; the script
 *     still exits 0.
 *   - Source files under components/ui/** that are not registered in the
 *     exports map are counted and reported as a stderr INFO message (private
 *     implementation details, useful design-system-maintenance signal).
 *   - Coverage signal is sourced from the desktop test suite (node:test +
 *     `--experimental-test-coverage --test-reporter=lcov`). Desktop tests today
 *     are main-process-only; renderer files are imported but not executed
 *     because there is no jsdom / RTL / Playwright harness. The detector
 *     accurately reports renderer imports as `imported-not-exercised` until a
 *     renderer test harness is added. That gap is the next-fidelity bottleneck.
 *
 * CLI flags:
 *   --json                    Emit JSON to stdout instead of Markdown.
 *   --coverage-lcov <path>    Path to LCOV file from desktop test coverage.
 *                             When absent, coverage / Storybook sections are
 *                             omitted (graceful degradation).
 *   --storybook-dir <path>    Directory containing *.stories.tsx files.
 *                             Defaults to ../../apps/storybook/stories.
 *
 * Reports are tagged with the workspace HEAD commit for reproducibility.
 *
 * Exit code: always 0. Drift at every fidelity is a discovery signal, not a
 * gate. `tsc` / build jobs are the gate for breaking changes; this report
 * surfaces the same data earlier and adds the usage-fidelity signals.
 *
 * Assumptions:
 *   - Run after `pnpm install --frozen-lockfile` so workspace source resolves.
 *   - Script lives at `apps/desktop/scripts/check-design-system-drift.mjs`.
 *
 * JSON schema (additive; bumped to "2" in FEA-1568):
 * {
 *   "schemaVersion": "2",
 *   "workspaceCommit": "<git rev-parse HEAD or 'unknown'>",
 *   "designSystemSpecifiers": <number>,
 *   "designSystemExports": <number>,
 *   "rendererImportSites": <number>,
 *   "importedExports": <number>,
 *   "notImported": [{ "specifier": "@closedloop-ai/design-system/...", "name": "..." }],
 *   "importsWithoutExports": [
 *     { "specifier": "...", "name": "...", "file": "<rel path>" }
 *   ],
 *   "coverageEnabled": <boolean>,
 *   "importedAndExercised": <number>,
 *   "importedNotExercised": [
 *     { "specifier": "...", "name": "...", "importingFiles": ["<rel path>", ...] }
 *   ],
 *   "storybookEnabled": <boolean>,
 *   "storiesScanned": <number>,
 *   "storiesWithoutDesktopCoverage": [
 *     { "storyFile": "<rel path>", "component": "...", "designSystemSpecifier": "..." }
 *   ]
 * }
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PACKAGE_NAME = "@closedloop-ai/design-system";
const PACKAGE_PREFIX = `${PACKAGE_NAME}/`;
// Storybook (apps/storybook) imports the design-system through the `@repo/*`
// alias declared in its package.json (`"@repo/design-system": "workspace:@closedloop-ai/design-system@*"`).
// Story scans need to canonicalize both shapes to the same specifier.
const STORYBOOK_ALIAS_NAME = "@repo/design-system";
const STORYBOOK_ALIAS_PREFIX = `${STORYBOOK_ALIAS_NAME}/`;
const SCHEMA_VERSION = "2";

const TS_FILE_PATTERN = /\.(?:tsx?|mts|cts)$/;
const TEST_FILE_PATTERN = /\.(?:test|spec|stories)\.(?:tsx?|mts|cts)$/;
const NON_TS_EXPORTS_PATTERN = /\.(?:css|mjs|cjs|json)$/;
const STORY_FILE_PATTERN = /\.stories\.tsx?$/;
const LCOV_LINE_SPLIT = /\r?\n/;

function compareStrings(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(desktopDir, "..", "..");
const designSystemDir = path.join(workspaceRoot, "packages", "design-system");
const designSystemUiDir = path.join(designSystemDir, "components", "ui");
const designSystemIndex = path.join(designSystemDir, "index.tsx");
const rendererDir = path.join(desktopDir, "src", "renderer");
const defaultStorybookDir = path.join(
  workspaceRoot,
  "apps",
  "storybook",
  "stories"
);

function parseCliArgs(argv) {
  let emitJson = false;
  /** @type {string | null} */
  let coverageLcov = null;
  /** @type {string} */
  let storybookDir = defaultStorybookDir;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      emitJson = true;
    } else if (arg === "--coverage-lcov") {
      coverageLcov = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--coverage-lcov=")) {
      coverageLcov = arg.slice("--coverage-lcov=".length);
    } else if (arg === "--storybook-dir") {
      // Resolve relative values against the caller's cwd so paths in the
      // emitted report stay anchored to the workspace, regardless of how
      // CI or a developer invokes the script.
      const value = argv[i + 1];
      if (value) {
        storybookDir = path.resolve(process.cwd(), value);
      }
      i += 1;
    } else if (arg.startsWith("--storybook-dir=")) {
      storybookDir = path.resolve(
        process.cwd(),
        arg.slice("--storybook-dir=".length)
      );
    }
  }
  return { emitJson, coverageLcov, storybookDir };
}

const { emitJson, coverageLcov, storybookDir } = parseCliArgs(
  process.argv.slice(2)
);

function getWorkspaceCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function listSourceFiles(rootDir, { excludeTestFiles = false } = {}) {
  /** @type {string[]} */
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && TS_FILE_PATTERN.test(entry.name)) {
        if (excludeTestFiles && TEST_FILE_PATTERN.test(entry.name)) {
          continue;
        }
        files.push(full);
      }
    }
  }
  walk(rootDir);
  return files;
}

function parseFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
}

function hasExportModifier(node) {
  return (
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    ) ?? false
  );
}

function exportsFromVariableStatement(statement) {
  /** @type {string[]} */
  const names = [];
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name)) {
      names.push(declaration.name.text);
    }
    // Destructuring patterns are skipped at this fidelity.
  }
  return names;
}

function exportsFromNamedDeclaration(statement) {
  // FunctionDeclaration, ClassDeclaration, InterfaceDeclaration,
  // TypeAliasDeclaration, EnumDeclaration — all expose `statement.name?.text`.
  return statement.name ? [statement.name.text] : [];
}

function exportsFromExportDeclaration(statement) {
  /** @type {string[]} */
  const names = [];
  if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    for (const element of statement.exportClause.elements) {
      // `export { Foo as Bar }` exposes "Bar" externally.
      names.push(element.name.text);
    }
  }
  return names;
}

function namedExportsForStatement(statement) {
  if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
    return exportsFromVariableStatement(statement);
  }
  if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement)) {
    return exportsFromNamedDeclaration(statement);
  }
  if (ts.isClassDeclaration(statement) && hasExportModifier(statement)) {
    return exportsFromNamedDeclaration(statement);
  }
  if (ts.isInterfaceDeclaration(statement) && hasExportModifier(statement)) {
    return exportsFromNamedDeclaration(statement);
  }
  if (ts.isTypeAliasDeclaration(statement) && hasExportModifier(statement)) {
    return exportsFromNamedDeclaration(statement);
  }
  if (ts.isEnumDeclaration(statement) && hasExportModifier(statement)) {
    return exportsFromNamedDeclaration(statement);
  }
  if (ts.isExportDeclaration(statement)) {
    return exportsFromExportDeclaration(statement);
  }
  return [];
}

function collectNamedExports(sourceFile) {
  /** @type {string[]} */
  const names = [];
  for (const statement of sourceFile.statements) {
    names.push(...namedExportsForStatement(statement));
  }
  return names;
}

function fileToSpecifier(absPath) {
  if (absPath === designSystemIndex) {
    return PACKAGE_NAME;
  }
  const relative = path.relative(designSystemDir, absPath);
  const withoutExt = relative.replace(TS_FILE_PATTERN, "");
  const posix = withoutExt.split(path.sep).join("/");
  return `${PACKAGE_NAME}/${posix}`;
}

function isInternalPath(filePath) {
  return filePath
    .split(path.sep)
    .some((segment) => segment === "internal" || segment.startsWith("__"));
}

function importsForStatement(statement) {
  /** @type {{specifier: string, name: string}[]} */
  const collected = [];
  if (!ts.isImportDeclaration(statement)) {
    return collected;
  }
  const moduleSpecifier = statement.moduleSpecifier;
  if (!ts.isStringLiteral(moduleSpecifier)) {
    return collected;
  }
  const specifier = moduleSpecifier.text;
  const isPackageMatch =
    specifier === PACKAGE_NAME || specifier.startsWith(`${PACKAGE_NAME}/`);
  if (!isPackageMatch) {
    return collected;
  }
  const clause = statement.importClause;
  if (!clause) {
    return collected;
  }
  const bindings = clause.namedBindings;
  if (!bindings) {
    return collected;
  }
  if (!ts.isNamedImports(bindings)) {
    return collected;
  }
  for (const element of bindings.elements) {
    // `import { Foo as Bar }` — match against the origin name "Foo".
    const originName = (element.propertyName ?? element.name).text;
    collected.push({ specifier, name: originName });
  }
  return collected;
}

function collectNamedImports(sourceFile) {
  /** @type {{specifier: string, name: string}[]} */
  const imports = [];
  for (const statement of sourceFile.statements) {
    imports.push(...importsForStatement(statement));
  }
  return imports;
}

function loadPublicSpecifiers() {
  // Use `package.json#exports` as the source of truth for the public API
  // surface. Skip non-source entries (CSS, postcss config, JSON, etc.) so the
  // surface walk only considers TS/TSX subpaths.
  const pkgPath = path.join(designSystemDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  /** @type {Set<string>} */
  const specifiers = new Set();
  for (const entry of Object.keys(pkg.exports ?? {})) {
    if (NON_TS_EXPORTS_PATTERN.test(entry)) {
      continue;
    }
    if (entry === ".") {
      specifiers.add(PACKAGE_NAME);
    } else if (entry.startsWith("./")) {
      specifiers.add(`${PACKAGE_NAME}/${entry.slice(2)}`);
    }
  }
  return specifiers;
}

function specifierToSourceFile(specifier) {
  if (specifier === PACKAGE_NAME) {
    return fs.existsSync(designSystemIndex) ? designSystemIndex : null;
  }
  if (!specifier.startsWith(PACKAGE_PREFIX)) {
    return null;
  }
  const rel = specifier.slice(PACKAGE_PREFIX.length);
  const base = path.join(designSystemDir, rel);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function buildExportSurface(publicSpecifiers) {
  // Drive the export surface from `publicSpecifiers` (which itself comes from
  // package.json#exports). For each public specifier resolve to a source file
  // and collect named exports. This covers every public subpath — not just
  // components/ui/** — so hooks/*, providers/*, lib/* are scanned too.
  /** @type {Map<string, Set<string>>} */
  const bySpecifier = new Map();
  /** @type {string[]} */
  const unresolved = [];
  for (const specifier of publicSpecifiers) {
    const filePath = specifierToSourceFile(specifier);
    if (!filePath) {
      unresolved.push(specifier);
      continue;
    }
    const exports = collectNamedExports(parseFile(filePath));
    if (exports.length === 0) {
      continue;
    }
    const set = new Set();
    for (const name of exports) {
      set.add(name);
    }
    bySpecifier.set(specifier, set);
  }
  // Separately, count source files under components/ui/** that are NOT in the
  // exports map — useful design-system-maintenance signal (private files that
  // someone may have intended to be public).
  let privateFileCount = 0;
  const sourceFiles = listSourceFiles(designSystemUiDir).filter(
    (file) => !isInternalPath(file)
  );
  for (const filePath of sourceFiles) {
    if (!publicSpecifiers.has(fileToSpecifier(filePath))) {
      privateFileCount += 1;
    }
  }
  return { bySpecifier, privateFileCount, unresolved };
}

function buildRendererImports(publicSpecifiers) {
  const files = listSourceFiles(rendererDir, { excludeTestFiles: true });
  /** @type {Set<string>} */
  const importedKeys = new Set();
  /** @type {Set<string>} */
  const offSurfaceSpecifiers = new Set();
  /** @type {Map<string, Set<string>>} key="specifier::name" -> absolute file paths */
  const importedKeyToFiles = new Map();
  let importSites = 0;
  for (const filePath of files) {
    // Cheap substring pre-check: skip files that don't reference the package
    // before paying for a full TypeScript parse. Most renderer files don't
    // import design-system at all.
    const source = fs.readFileSync(filePath, "utf8");
    if (!source.includes(PACKAGE_NAME)) {
      continue;
    }
    const imports = collectNamedImports(parseFile(filePath));
    for (const { specifier, name } of imports) {
      const key = `${specifier}::${name}`;
      importedKeys.add(key);
      importSites += 1;
      if (!publicSpecifiers.has(specifier)) {
        offSurfaceSpecifiers.add(specifier);
      }
      let fileSet = importedKeyToFiles.get(key);
      if (!fileSet) {
        fileSet = new Set();
        importedKeyToFiles.set(key, fileSet);
      }
      fileSet.add(filePath);
    }
  }
  return {
    importedKeys,
    importSites,
    offSurfaceSpecifiers,
    importedKeyToFiles,
  };
}

// ---------------------------------------------------------------------------
// FEA-1568 helpers — LCOV parsing, Storybook scan, canonicalization.
// ---------------------------------------------------------------------------

function canonicalizeSpecifier(specifier) {
  // Stories import design-system via the `@repo/design-system` alias (declared
  // in apps/storybook/package.json). Map either flavor to the canonical
  // `@closedloop-ai/design-system` form so cross-references against renderer
  // imports use a single key space.
  if (specifier === STORYBOOK_ALIAS_NAME) {
    return PACKAGE_NAME;
  }
  if (specifier.startsWith(STORYBOOK_ALIAS_PREFIX)) {
    return `${PACKAGE_NAME}/${specifier.slice(STORYBOOK_ALIAS_PREFIX.length)}`;
  }
  return specifier;
}

function parseLcovDaHits(line) {
  // DA:<line_number>,<execution_count>
  const comma = line.indexOf(",");
  if (comma === -1) {
    return 0;
  }
  const count = Number.parseInt(line.slice(comma + 1), 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function parseLcovFndaHits(line) {
  // FNDA:<hits>,<fn_name>
  const comma = line.indexOf(",");
  if (comma === -1) {
    return 0;
  }
  const hits = Number.parseInt(line.slice("FNDA:".length, comma), 10);
  return Number.isFinite(hits) && hits > 0 ? hits : 0;
}

function lineMarksExercised(line) {
  // Returns true if this LCOV record line signals that the current file has
  // at least one execution (line or function). Pulled out of parseLcov to
  // keep that function below the cognitive-complexity ceiling.
  if (line.startsWith("DA:")) {
    return parseLcovDaHits(line) > 0;
  }
  if (line.startsWith("FNDA:")) {
    return parseLcovFndaHits(line) > 0;
  }
  return false;
}

function inferLcovSourceRoot(absLcovPath) {
  // Node's --test-reporter=lcov emits SF: paths relative to the test runner's
  // cwd (apps/desktop in our case), and writes lcov.info to that cwd's
  // coverage/ output dir. So if the lcov file lives at `<X>/coverage/lcov.info`,
  // SF: paths resolve against `<X>`. Otherwise (e.g. unit-test fixtures that
  // co-locate the lcov file alongside its referenced sources), fall back to
  // the lcov file's own directory so existing parser tests keep passing.
  const lcovDir = path.dirname(absLcovPath);
  if (path.basename(lcovDir) === "coverage") {
    return path.dirname(lcovDir);
  }
  return lcovDir;
}

function parseLcov(absLcovPath) {
  // Minimal LCOV parser. Tracks which files appear (SF:) and which have any
  // executed line (any DA:<line>,<count> with count > 0 OR any function
  // record with FNDA:<hits>, hits > 0). Returns the set of absolute paths
  // of files that were exercised by at least one test.
  //
  // Split on /\r?\n/ so Windows-CRLF lcov files (and `end_of_record\r`)
  // still parse correctly — a pure '\n' split leaves a trailing '\r' on
  // every line, which would defeat the `=== "end_of_record"` check and
  // never reset `currentExercised`, causing the next record's
  // current-exercised state to bleed across SF: boundaries.
  //
  // Resolves a moderate-size lcov file (~1 MB / 90k lines) in O(n).
  const text = fs.readFileSync(absLcovPath, "utf8");
  const sourceRoot = inferLcovSourceRoot(absLcovPath);
  /** @type {Set<string>} */
  const exercisedFiles = new Set();
  /** @type {Set<string>} */
  const allFiles = new Set();
  let currentFile = "";
  let currentExercised = false;
  for (const line of text.split(LCOV_LINE_SPLIT)) {
    if (line.startsWith("SF:")) {
      if (currentFile && currentExercised) {
        exercisedFiles.add(currentFile);
      }
      currentFile = path.resolve(sourceRoot, line.slice(3).trim());
      currentExercised = false;
      allFiles.add(currentFile);
      continue;
    }
    if (!currentFile) {
      continue;
    }
    if (line === "end_of_record") {
      if (currentExercised) {
        exercisedFiles.add(currentFile);
      }
      currentFile = "";
      currentExercised = false;
      continue;
    }
    if (!currentExercised && lineMarksExercised(line)) {
      currentExercised = true;
    }
  }
  // Flush the final record in case the file doesn't end with end_of_record.
  if (currentFile && currentExercised) {
    exercisedFiles.add(currentFile);
  }
  return { exercisedFiles, allFiles };
}

function listStoryFiles(dir) {
  // Recurse into subdirectories so a future re-organization of
  // apps/storybook/stories into per-component-family subdirs doesn't
  // silently drop those stories from the drift scan. Mirrors the recursion
  // pattern in listSourceFiles.
  if (!fs.existsSync(dir)) {
    return [];
  }
  /** @type {string[]} */
  const files = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && STORY_FILE_PATTERN.test(entry.name)) {
        files.push(full);
      }
    }
  }
  walk(dir);
  return files;
}

function unwrapTypeAssertions(expr) {
  // Walks past `satisfies` and `as` wrappers to reach the underlying value.
  let obj = expr;
  while (obj && ts.isSatisfiesExpression(obj)) {
    obj = obj.expression;
  }
  if (obj && ts.isAsExpression(obj)) {
    obj = obj.expression;
  }
  return obj;
}

function objectLiteralComponentName(expr) {
  const obj = unwrapTypeAssertions(expr);
  if (!(obj && ts.isObjectLiteralExpression(obj))) {
    return null;
  }
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === "component" &&
      ts.isIdentifier(prop.initializer)
    ) {
      return prop.initializer.text;
    }
  }
  return null;
}

function collectImportBindings(sourceFile) {
  // Build a map of local-name → { specifier, originName } for every named
  // VALUE import in the file. Story files alias the design-system component
  // into a local binding, so the cross-reference uses the origin name.
  //
  // Type-only imports (`import type { X }` or `import { type X }`) are
  // skipped: they are erased at compile time and never refer to runtime
  // values that a Storybook `component:` field could hold. Including them
  // could shadow a real value import with the same local name and
  // mis-attribute the story to a phantom design-system specifier.
  /** @type {Map<string, {specifier: string, originName: string}>} */
  const importBindings = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) {
      continue;
    }
    const specifier = moduleSpecifier.text;
    const clause = statement.importClause;
    if (!(clause?.namedBindings && ts.isNamedImports(clause.namedBindings))) {
      continue;
    }
    if (clause.isTypeOnly) {
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      const originName = (element.propertyName ?? element.name).text;
      const localName = element.name.text;
      importBindings.set(localName, { specifier, originName });
    }
  }
  return importBindings;
}

function findMetaBinding(sourceFile) {
  // Locate `const meta = { ... }` (the canonical CSF shape). Story files
  // also occasionally inline the object on the default export — that path
  // is handled below in resolveDefaultExportComponentName.
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "meta" &&
        declaration.initializer
      ) {
        return {
          name: declaration.name.text,
          initializer: declaration.initializer,
        };
      }
    }
  }
  return null;
}

function resolveDefaultExportComponentName(sourceFile, metaBinding) {
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement)) {
      continue;
    }
    const expression = statement.expression;
    const exportsMeta =
      metaBinding &&
      ts.isIdentifier(expression) &&
      expression.text === metaBinding.name;
    const name = exportsMeta
      ? objectLiteralComponentName(metaBinding.initializer)
      : objectLiteralComponentName(expression);
    if (name) {
      return name;
    }
  }
  return null;
}

function extractStoryComponentBinding(sourceFile) {
  // Find the default-exported `meta` (or inline default-export object) and
  // pull the identifier under its `component:` property. Handles both shapes:
  //   const meta = { component: Button, ... } satisfies Meta<typeof Button>;
  //   export default meta;
  //
  //   export default { component: Button } satisfies Meta<typeof Button>;
  //
  // Returns the bound identifier text (e.g. "Button") or null when the story
  // file doesn't follow the standard pattern.
  const importBindings = collectImportBindings(sourceFile);
  const metaBinding = findMetaBinding(sourceFile);
  const componentName = resolveDefaultExportComponentName(
    sourceFile,
    metaBinding
  );
  if (!componentName) {
    return null;
  }
  const binding = importBindings.get(componentName);
  if (!binding) {
    return null;
  }
  return {
    component: binding.originName,
    specifier: canonicalizeSpecifier(binding.specifier),
  };
}

function buildStorybookCoverage(
  dir,
  exercisedRendererFiles,
  importedKeyToFiles
) {
  const files = listStoryFiles(dir);
  /** @type {{storyFile: string, component: string, designSystemSpecifier: string}[]} */
  const storiesWithoutCoverage = [];
  let scanned = 0;
  for (const filePath of files) {
    // Cheap substring pre-check: skip story files that don't reference the
    // design-system at all before paying for a full TypeScript AST parse.
    // Mirrors the same optimization in buildRendererImports.
    const source = fs.readFileSync(filePath, "utf8");
    if (
      !(source.includes(PACKAGE_NAME) || source.includes(STORYBOOK_ALIAS_NAME))
    ) {
      continue;
    }
    const sourceFile = parseFile(filePath);
    const binding = extractStoryComponentBinding(sourceFile);
    if (!binding) {
      continue;
    }
    if (
      binding.specifier !== PACKAGE_NAME &&
      !binding.specifier.startsWith(PACKAGE_PREFIX)
    ) {
      continue;
    }
    scanned += 1;
    const key = `${binding.specifier}::${binding.component}`;
    const importingFiles = importedKeyToFiles.get(key);
    const hasExercisedConsumer =
      !!importingFiles &&
      [...importingFiles].some((f) => exercisedRendererFiles.has(f));
    if (!hasExercisedConsumer) {
      storiesWithoutCoverage.push({
        storyFile: filePath,
        component: binding.component,
        designSystemSpecifier: binding.specifier,
      });
    }
  }
  return { scanned, storiesWithoutCoverage };
}

function relativeFromWorkspace(absPath) {
  const rel = path.relative(workspaceRoot, absPath);
  return rel.split(path.sep).join("/");
}

function emitStderrWarnings(
  privateFileCount,
  unresolved,
  offSurfaceSpecifiers
) {
  if (privateFileCount > 0) {
    process.stderr.write(
      `[check-design-system-drift] INFO: ${privateFileCount} source file(s) under packages/design-system/components/ui/ are not registered in package.json#exports and were excluded from the drift surface (private implementation details).\n`
    );
  }
  // Warn for any public exports entry that does not resolve to a TS source
  // file (typo, missing file, exports-map drift, etc.).
  for (const specifier of unresolved) {
    process.stderr.write(
      `[check-design-system-drift] WARNING: package.json#exports entry "${specifier}" does not resolve to a TS source file (.ts/.tsx/.mts or index file); skipped.\n`
    );
  }
  // Warn when the renderer imports a specifier not registered in the package's
  // exports map. That's either a private subpath import (consumer reaching
  // into design-system internals) or an exports-map gap; either way, worth
  // surfacing.
  for (const specifier of offSurfaceSpecifiers) {
    process.stderr.write(
      `[check-design-system-drift] WARNING: renderer imports from "${specifier}" but that specifier is not in packages/design-system/package.json#exports. Either the import path is private (should not be reached from outside the package) or the exports map needs to add it.\n`
    );
  }
}

function computeForwardDrift(exportSurface, importedKeys) {
  /** @type {{specifier: string, name: string}[]} */
  const notImported = [];
  let totalExports = 0;
  let importedCount = 0;
  const sortedSpecifiers = [...exportSurface.keys()].sort();
  for (const specifier of sortedSpecifiers) {
    const names = [...exportSurface.get(specifier)].sort();
    for (const name of names) {
      totalExports += 1;
      if (importedKeys.has(`${specifier}::${name}`)) {
        importedCount += 1;
      } else {
        notImported.push({ specifier, name });
      }
    }
  }
  return { notImported, totalExports, importedCount };
}

function splitKey(key) {
  const sepIdx = key.indexOf("::");
  return { specifier: key.slice(0, sepIdx), name: key.slice(sepIdx + 2) };
}

function computeInverseDrift(
  publicSpecifiers,
  exportSurface,
  importedKeyToFiles
) {
  /** @type {{specifier: string, name: string, file: string}[]} */
  const importsWithoutExports = [];
  for (const [key, fileSet] of importedKeyToFiles) {
    const { specifier, name } = splitKey(key);
    // Off-surface specifiers already warn earlier; skip from the inverse
    // pass to avoid duplicating that signal.
    if (!publicSpecifiers.has(specifier)) {
      continue;
    }
    const names = exportSurface.get(specifier);
    if (!names || names.has(name)) {
      continue;
    }
    for (const file of fileSet) {
      importsWithoutExports.push({
        specifier,
        name,
        file: relativeFromWorkspace(file),
      });
    }
  }
  importsWithoutExports.sort((a, b) => {
    const bySpec = compareStrings(a.specifier, b.specifier);
    if (bySpec !== 0) {
      return bySpec;
    }
    const byName = compareStrings(a.name, b.name);
    if (byName !== 0) {
      return byName;
    }
    return compareStrings(a.file, b.file);
  });
  return importsWithoutExports;
}

function loadCoverageExercisedFiles(coverageLcovArg) {
  if (coverageLcovArg === null) {
    return { coverageEnabled: false, exercisedRendererFiles: new Set() };
  }
  const lcovPath = path.resolve(process.cwd(), coverageLcovArg);
  if (!fs.existsSync(lcovPath)) {
    // Treat a missing lcov file the same as `--coverage-lcov` not being
    // passed. Reporting `coverageEnabled: true` with an empty set would
    // flood the coverage section with every renderer-consumed export and
    // every story as "uncovered", masking real drift signal in CI when
    // the upstream desktop job failed to upload the artifact.
    process.stderr.write(
      `[check-design-system-drift] WARNING: --coverage-lcov path "${coverageLcovArg}" does not exist; coverage and Storybook sections will be omitted.\n`
    );
    return { coverageEnabled: false, exercisedRendererFiles: new Set() };
  }
  const { exercisedFiles } = parseLcov(lcovPath);
  return { coverageEnabled: true, exercisedRendererFiles: exercisedFiles };
}

function computeCoverageDrift(
  publicSpecifiers,
  exportSurface,
  importedKeyToFiles,
  exercisedRendererFiles
) {
  let importedAndExercised = 0;
  /** @type {{specifier: string, name: string, importingFiles: string[]}[]} */
  const importedNotExercised = [];
  for (const [key, fileSet] of importedKeyToFiles) {
    const { specifier, name } = splitKey(key);
    if (!publicSpecifiers.has(specifier)) {
      continue;
    }
    const names = exportSurface.get(specifier);
    if (!names?.has(name)) {
      // Inverse case: surfaced in importsWithoutExports.
      continue;
    }
    const anyExercised = [...fileSet].some((f) =>
      exercisedRendererFiles.has(f)
    );
    if (anyExercised) {
      importedAndExercised += 1;
    } else {
      importedNotExercised.push({
        specifier,
        name,
        importingFiles: [...fileSet]
          .map((f) => relativeFromWorkspace(f))
          .sort(),
      });
    }
  }
  importedNotExercised.sort((a, b) => {
    const bySpec = compareStrings(a.specifier, b.specifier);
    if (bySpec !== 0) {
      return bySpec;
    }
    return compareStrings(a.name, b.name);
  });
  return { importedAndExercised, importedNotExercised };
}

function computeReport() {
  const workspaceCommit = getWorkspaceCommit();
  const publicSpecifiers = loadPublicSpecifiers();
  const {
    bySpecifier: exportSurface,
    privateFileCount,
    unresolved,
  } = buildExportSurface(publicSpecifiers);
  const {
    importedKeys,
    importSites,
    offSurfaceSpecifiers,
    importedKeyToFiles,
  } = buildRendererImports(publicSpecifiers);

  emitStderrWarnings(privateFileCount, unresolved, offSurfaceSpecifiers);

  const { notImported, totalExports, importedCount } = computeForwardDrift(
    exportSurface,
    importedKeys
  );

  const importsWithoutExports = computeInverseDrift(
    publicSpecifiers,
    exportSurface,
    importedKeyToFiles
  );

  const { coverageEnabled, exercisedRendererFiles } =
    loadCoverageExercisedFiles(coverageLcov);

  let importedAndExercised = 0;
  /** @type {{specifier: string, name: string, importingFiles: string[]}[]} */
  let importedNotExercised = [];
  if (coverageEnabled) {
    ({ importedAndExercised, importedNotExercised } = computeCoverageDrift(
      publicSpecifiers,
      exportSurface,
      importedKeyToFiles,
      exercisedRendererFiles
    ));
  }

  // ---------------------------------------------------------------------
  // FEA-1568 AC-090.2.c — Storybook-based detection. Stories whose backing
  // design-system component has no exercised renderer consumer.
  // ---------------------------------------------------------------------
  const storybookExists = fs.existsSync(storybookDir);
  const storybookEnabled = coverageEnabled && storybookExists;
  let storiesScanned = 0;
  /** @type {{storyFile: string, component: string, designSystemSpecifier: string}[]} */
  let storiesWithoutDesktopCoverage = [];
  if (storybookEnabled) {
    const { scanned, storiesWithoutCoverage } = buildStorybookCoverage(
      storybookDir,
      exercisedRendererFiles,
      importedKeyToFiles
    );
    storiesScanned = scanned;
    storiesWithoutDesktopCoverage = storiesWithoutCoverage
      .map((entry) => ({
        ...entry,
        storyFile: relativeFromWorkspace(entry.storyFile),
      }))
      .sort((a, b) => compareStrings(a.storyFile, b.storyFile));
  } else if (storybookDir && !storybookExists) {
    process.stderr.write(
      `[check-design-system-drift] WARNING: --storybook-dir "${storybookDir}" does not exist; Storybook section will be omitted.\n`
    );
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceCommit,
    designSystemSpecifiers: exportSurface.size,
    designSystemExports: totalExports,
    rendererImportSites: importSites,
    importedExports: importedCount,
    notImported,
    importsWithoutExports,
    coverageEnabled,
    importedAndExercised,
    importedNotExercised,
    storybookEnabled,
    storiesScanned,
    storiesWithoutDesktopCoverage,
  };
}

function renderHeader(report) {
  const rows = [
    "## Design-system parity-drift report",
    "",
    "**Source:** [FEA-1516](https://app.closedloop.ai/closedloop-ai/features/FEA-1516) · [PLN-848](https://app.closedloop.ai/closedloop-ai/implementation-plans/PLN-848) — forward (exports-not-imported).",
    "**Higher-fidelity additions:** [FEA-1568](https://app.closedloop.ai/closedloop-ai/features/FEA-1568) · [PLN-867](https://app.closedloop.ai/closedloop-ai/implementation-plans/PLN-867) — inverse (AC-090.2.d), coverage-based (AC-090.2.b), Storybook-based (AC-090.2.c).",
    "",
    `**Workspace commit:** \`${report.workspaceCommit}\``,
    "",
    "| Metric | Count |",
    "|---|---|",
    `| Design-system subpath specifiers scanned | ${report.designSystemSpecifiers} |`,
    `| Total named exports | ${report.designSystemExports} |`,
    `| Exports consumed by renderer | ${report.importedExports} |`,
    `| Exports not consumed by renderer | ${report.notImported.length} |`,
    `| Renderer named-import sites scanned | ${report.rendererImportSites} |`,
    `| Renderer imports with no matching export (inverse) | ${report.importsWithoutExports.length} |`,
  ];
  if (report.coverageEnabled) {
    rows.push(
      `| Renderer-consumed exports exercised by tests | ${report.importedAndExercised} |`,
      `| Renderer-consumed exports without test coverage | ${report.importedNotExercised.length} |`
    );
  }
  if (report.storybookEnabled) {
    rows.push(
      `| Storybook stories scanned | ${report.storiesScanned} |`,
      `| Stories without desktop coverage | ${report.storiesWithoutDesktopCoverage.length} |`
    );
  }
  rows.push("");
  return rows;
}

function renderNotImported(notImported) {
  if (notImported.length === 0) {
    return [
      "### Forward (FEA-1516): exports not consumed by renderer",
      "",
      "No drift detected. Every scanned design-system export is consumed by at least one renderer file.",
      "",
    ];
  }
  const lines = [
    "### Forward (FEA-1516): exports not consumed by renderer",
    "",
    "Grouped by subpath specifier. See `apps/desktop/docs/shared-architecture-migration.md` for adoption sequencing.",
    "",
  ];
  let currentSpecifier = "";
  for (const { specifier, name } of notImported) {
    if (specifier !== currentSpecifier) {
      if (currentSpecifier !== "") {
        lines.push("");
      }
      lines.push(`- \`${specifier}\``);
      currentSpecifier = specifier;
    }
    lines.push(`  - \`${name}\``);
  }
  lines.push("");
  return lines;
}

function renderImportsWithoutExports(importsWithoutExports) {
  if (importsWithoutExports.length === 0) {
    return [
      "### Inverse (FEA-1568 AC-090.2.d): renderer imports with no matching design-system export",
      "",
      "No inverse drift detected. Every renderer named import resolves to an export.",
      "",
    ];
  }
  const lines = [
    "### Inverse (FEA-1568 AC-090.2.d): renderer imports with no matching design-system export",
    "",
    "These imports would fail a fresh `tsc` build (or be silently broken at runtime if the symbol is dropped from a barrel re-export). Surfaced here so the discovery happens at PR-summary time rather than at the build job's failure.",
    "",
  ];
  for (const { specifier, name, file } of importsWithoutExports) {
    lines.push(
      `- \`${specifier}\` → missing export \`${name}\` (imported in \`${file}\`)`
    );
  }
  lines.push("");
  return lines;
}

function renderImportedNotExercised(report) {
  if (!report.coverageEnabled) {
    return [
      "### Coverage-based (FEA-1568 AC-090.2.b): renderer-consumed exports without test coverage",
      "",
      "Coverage section omitted — invoke with `--coverage-lcov <path>` after running `pnpm --filter desktop test` to populate this section.",
      "",
    ];
  }
  if (report.importedNotExercised.length === 0) {
    return [
      "### Coverage-based (FEA-1568 AC-090.2.b): renderer-consumed exports without test coverage",
      "",
      "Every renderer-consumed design-system export has at least one importing renderer file with an exercised line.",
      "",
    ];
  }
  const lines = [
    "### Coverage-based (FEA-1568 AC-090.2.b): renderer-consumed exports without test coverage",
    "",
    "Each row is a design-system export imported by renderer code whose importing files have no executed line in the desktop coverage report. Today's desktop suite is main-process-only (no jsdom / RTL / Playwright), so renderer imports register as unexercised until a renderer test harness exists.",
    "",
  ];
  let currentSpecifier = "";
  for (const {
    specifier,
    name,
    importingFiles,
  } of report.importedNotExercised) {
    if (specifier !== currentSpecifier) {
      if (currentSpecifier !== "") {
        lines.push("");
      }
      lines.push(`- \`${specifier}\``);
      currentSpecifier = specifier;
    }
    const filesSnippet = importingFiles.slice(0, 3).join(", ");
    const more =
      importingFiles.length > 3 ? ` (+${importingFiles.length - 3} more)` : "";
    lines.push(`  - \`${name}\` — imported by ${filesSnippet}${more}`);
  }
  lines.push("");
  return lines;
}

function renderStoriesWithoutCoverage(report) {
  if (!report.storybookEnabled) {
    return [
      "### Storybook-based (FEA-1568 AC-090.2.c): stories without desktop coverage",
      "",
      "Storybook section omitted — requires `--coverage-lcov <path>` plus an existing `--storybook-dir` (default `apps/storybook/stories`).",
      "",
    ];
  }
  if (report.storiesWithoutDesktopCoverage.length === 0) {
    return [
      "### Storybook-based (FEA-1568 AC-090.2.c): stories without desktop coverage",
      "",
      `All ${report.storiesScanned} scanned stories have at least one exercised renderer consumer.`,
      "",
    ];
  }
  const lines = [
    "### Storybook-based (FEA-1568 AC-090.2.c): stories without desktop coverage",
    "",
    `${report.storiesWithoutDesktopCoverage.length} of ${report.storiesScanned} scanned design-system stories have no exercised renderer consumer.`,
    "",
  ];
  for (const {
    storyFile,
    component,
    designSystemSpecifier,
  } of report.storiesWithoutDesktopCoverage) {
    lines.push(
      `- \`${storyFile}\` — component \`${component}\` from \`${designSystemSpecifier}\``
    );
  }
  lines.push("");
  return lines;
}

function renderFooter() {
  return [
    "<sub>Generated by `apps/desktop/scripts/check-design-system-drift.mjs`. Run `pnpm --filter desktop check:design-system-drift -- --json` for the structured report.</sub>",
  ];
}

function renderMarkdown(report) {
  return [
    ...renderHeader(report),
    ...renderNotImported(report.notImported),
    ...renderImportsWithoutExports(report.importsWithoutExports),
    ...renderImportedNotExercised(report),
    ...renderStoriesWithoutCoverage(report),
    ...renderFooter(),
  ].join("\n");
}

// Exports for in-process testing. The CLI entrypoint below runs only when the
// file is invoked as a script — guarded so `import` from tests is side-effect
// free.
export {
  canonicalizeSpecifier,
  collectNamedExports,
  collectNamedImports,
  extractStoryComponentBinding,
  listStoryFiles,
  parseCliArgs,
  parseFile,
  parseLcov,
};

function isCliEntry() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isCliEntry()) {
  const report = computeReport();
  const payload = emitJson
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${renderMarkdown(report)}\n`;
  // Do NOT call process.exit(0). When stdout is piped (e.g. `>> $GITHUB_STEP_SUMMARY`
  // or another process via spawn) Node's stdout write is asynchronous and an
  // early exit truncates the buffered output (observed at ~65,536 bytes when
  // reading the JSON variant). Letting the process exit naturally drains stdout
  // first. process.exitCode defaults to 0; we leave it implicit.
  process.stdout.write(payload);
}
