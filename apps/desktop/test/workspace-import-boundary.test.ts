import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { collectTsFiles } from "./helpers/collect-ts-files.js";

// PLN-999 guardrail. The desktop main/preload/shared graph is bundled by
// electron-vite, which inlines `@repo/*` workspace TypeScript from SOURCE. A
// `@repo/...` import that reaches into `/dist/` or carries a `.js` extension is
// exactly the brittle pattern the bundling migration removed: it only "worked"
// for type-only imports (erased at compile) and crashed at load for value
// imports (`ERR_MODULE_NOT_FOUND` against `@repo/api/src/...js`, which ships
// only `.ts`). Import `@repo/*` as extensionless source instead.
//
// `@closedloop-ai/*` packages are intentionally NOT covered: they ship a proper
// `exports` map and are left external at runtime, so their bare subpath imports
// resolve correctly from node_modules.

const SCANNED_DIRS = ["src/main", "src/shared", "src/server"];
const IMPORT_FROM_PATTERN = /\bfrom\s*"([^"]+)"/g;
const BARE_IMPORT_PATTERN = /\bimport\s*"([^"]+)"/g;

function specifiersIn(source: string): string[] {
  const specs: string[] = [];
  for (const pattern of [IMPORT_FROM_PATTERN, BARE_IMPORT_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(source);
    while (match !== null) {
      specs.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return specs;
}

function isForbiddenRepoImport(specifier: string): boolean {
  if (!specifier.startsWith("@repo/")) {
    return false;
  }
  return specifier.includes("/dist/") || specifier.endsWith(".js");
}

describe("desktop workspace import boundary (PLN-999)", () => {
  test("no @repo/* import in main/preload/shared reaches into /dist/ or uses a .js extension", () => {
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of collectTsFiles(dir)) {
        const source = readFileSync(file, "utf8");
        for (const specifier of specifiersIn(source)) {
          if (isForbiddenRepoImport(specifier)) {
            offenders.push(`${file}: "${specifier}"`);
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Import @repo/* as extensionless source (no /dist/, no .js). Offending imports:\n${offenders.join("\n")}`
    );
  });
});
