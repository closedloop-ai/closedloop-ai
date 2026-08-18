// CI gate (docs/design/prototype-sandbox.md): every @repo/design-system
// component import in apps/prototypes must map to a non-internal entry in the
// Storybook component catalog. Wired as this package's "test" script and run
// on every PR by the pr-test.yml test job (--filter=prototypes). Deliberately
// NOT wired into the build: deploy builds stay test-free per FEA-1523.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const catalogPath = path.join(
  repoRoot,
  "packages/design-system/storybook/component-catalog.ts"
);

const catalog = await import(pathToFileURL(catalogPath).href);

const packagePrefixPattern = /^packages\/design-system\//;
const sourceFilePattern = /\.tsx?$/;

const allowedComponentSpecifiers = new Set(
  catalog.designSystemComponentCatalog
    .filter((entry) => !entry.internal)
    .map((entry) =>
      entry.sourcePath
        .replace(packagePrefixPattern, "@repo/design-system/")
        .replace(sourceFilePattern, "")
    )
);

// Non-component surfaces are infrastructure, not catalog entries: the root
// DesignSystemProvider, fonts/utils, theme provider, styles, hooks, shared
// storybook mock data, and the type/util modules colocated with components.
const infrastructurePattern =
  /^@repo\/design-system(\/(lib|providers|styles|hooks|storybook)\/.+)?$/;
const componentModuleAllowlist = new Set([
  "@repo/design-system/components/ui/chart-colors",
  "@repo/design-system/components/ui/types",
  "@repo/design-system/components/ui/utils",
  // Pure metric-polarity contract (ISS-4633): the MetricPolarity/DeltaSentiment
  // enums and their sentiment/class maps. No React, no component runtime, so it
  // has no Storybook story and cannot be a catalog entry — it is a type/util
  // module colocated with components, same category as the entries above.
  "@repo/design-system/components/ui/primitives/metric-polarity",
]);

const importPattern =
  /(?:from\s+|import\s+|import\()\s*["'](@repo\/design-system[^"']*)["']/g;

const violations = [];
let importCount = 0;
let fileCount = 0;

for (const dir of ["app", "lib"]) {
  const entries = readdirSync(path.join(appRoot, dir), {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!(entry.isFile() && sourceFilePattern.test(entry.name))) {
      continue;
    }
    fileCount += 1;
    const filePath = path.join(entry.parentPath, entry.name);
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      importCount += 1;
      const specifier = match[1];
      const reason = classify(specifier);
      if (reason) {
        violations.push(
          `${path.relative(repoRoot, filePath)}: "${specifier}" ${reason}`
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Catalog gate failed:\n");
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  console.error(
    "\nPrototypes may only use design-system components listed (non-internal) in" +
      "\npackages/design-system/storybook/component-catalog.ts. If the component" +
      "\nreally exists in Storybook, refresh the catalog first:" +
      "\n  pnpm --filter storybook catalog:sync"
  );
  process.exit(1);
}

console.log(
  `catalog gate ok (${importCount} design-system imports across ${fileCount} files)`
);

function classify(specifier) {
  if (infrastructurePattern.test(specifier)) {
    return null;
  }
  if (componentModuleAllowlist.has(specifier)) {
    return null;
  }
  if (specifier.startsWith("@repo/design-system/components/")) {
    if (allowedComponentSpecifiers.has(specifier)) {
      return null;
    }
    return "is not a non-internal component-catalog entry";
  }
  return "is not a known design-system surface (components/, lib/, providers/, styles/, hooks/, storybook/)";
}
