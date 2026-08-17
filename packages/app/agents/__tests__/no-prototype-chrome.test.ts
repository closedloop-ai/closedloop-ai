/**
 * AC-005 guardrail: prototype chrome must NOT be carried into production.
 *
 * T-3.8 (FEA-2923): Verifies that:
 *   1. No file under packages/app/agents/ imports from apps/prototypes/.
 *   2. The prototype-only chrome files (app-shell.tsx, app-sidebar.tsx,
 *      version-switcher.tsx, agents-workspace.tsx) were NOT copied into the
 *      agents workspace slice.
 *   3. packages/app/agents/lib/component-meta.tsx imports only from
 *      @repo/api, @closedloop-ai/design-system, lucide-react, and slice-relative paths
 *      — not from apps/prototypes.
 *
 * Note: agent-component-sample-data.ts was deleted in T-9.2 (stub removal).
 *
 * Follows the pattern established in:
 *   packages/app/agents/components/sessions/__tests__/source-guardrails.test.ts
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  importsOf,
  parseSourceFileAt,
} from "@repo/app/shared/testing/source-ast";
import { describe, expect, it } from "vitest";

// Resolve paths relative to this test file's directory.
const AGENTS_DIR = join(import.meta.dirname, "..");
const WORKSPACE_DIR = join(AGENTS_DIR, "components", "workspace");
const LIB_DIR = join(AGENTS_DIR, "lib");

// Prototype-only chrome filenames that must NOT appear in the production slice.
const PROTOTYPE_CHROME_FILES = [
  "app-shell.tsx",
  "app-sidebar.tsx",
  "version-switcher.tsx",
  "agents-workspace.tsx",
];

const TYPESCRIPT_SOURCE_RE = /\.(ts|tsx)$/;

// Allowed import prefix regexes at module top-level per useTopLevelRegex rule.
// Allow: @repo/api, @closedloop-ai/design-system, @repo/app (sibling slice imports),
// lucide-react, react, and slice-relative paths starting with ".".
// Disallow: apps/prototypes and any other unexpected external dependency.
const COMPONENT_META_ALLOWED_PREFIX_RE =
  /^(@repo\/api|@repo\/design-system|@repo\/app|lucide-react|react|\.)/;

// The prototype sandbox path, matched against resolved import specifiers.
const PROTOTYPE_SLICE_PATH = "apps/prototypes";

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return listSourceFiles(path);
    }
    return TYPESCRIPT_SOURCE_RE.test(path) ? [path] : [];
  });
}

function listProductionSourceFiles(dir: string): string[] {
  return listSourceFiles(dir).filter(
    (filePath) =>
      !(filePath.includes("__tests__") || filePath.endsWith(".stories.tsx"))
  );
}

describe("no-prototype-chrome guardrail (T-3.8 / AC-005)", () => {
  it("no file in packages/app/agents/ imports from apps/prototypes/", () => {
    // AST-based (FEA-4112), like the component-meta case below: the raw-text
    // regex this replaced could be tripped by a comment or string mentioning
    // the path, and never saw `export … from` or dynamic `import()` re-exports.
    const files = listProductionSourceFiles(AGENTS_DIR);
    const violations = files
      .filter((filePath) =>
        importsOf(parseSourceFileAt(filePath)).some(({ specifier }) =>
          specifier.includes(PROTOTYPE_SLICE_PATH)
        )
      )
      .map((filePath) => filePath.replace(`${AGENTS_DIR}/`, "agents/"));

    expect(violations).toEqual([]);
    // Non-vacuity: an empty or failed walk must not pass silently.
    expect(files.length).toBeGreaterThan(0);
  });

  it("prototype chrome files were NOT ported into the workspace slice", () => {
    for (const fileName of PROTOTYPE_CHROME_FILES) {
      const targetPath = join(WORKSPACE_DIR, fileName);
      expect(
        existsSync(targetPath),
        `Prototype chrome file was copied into the production slice: ${fileName}. ` +
          "Remove it — production uses the real design-system components."
      ).toBe(false);
    }
  });

  it("component-meta.tsx imports only from @repo/api, @closedloop-ai/design-system, lucide-react, or slice-relative paths", () => {
    // AST-based (FEA-4112): asserting on resolved module specifiers rather than
    // on the file text means a prototype path named in a comment is not a
    // violation, and a real import cannot hide behind unusual formatting.
    const importSpecifiers = importsOf(
      parseSourceFileAt(join(LIB_DIR, "component-meta.tsx"))
    ).map(({ specifier }) => specifier);

    // Sanity: the parse resolved real imports, so the filters below cannot pass
    // vacuously over an empty list.
    expect(importSpecifiers.length).toBeGreaterThan(0);

    // Must not import from apps/prototypes (redundant with first test, explicit for clarity).
    expect(
      importSpecifiers.filter((specifier) =>
        specifier.includes(PROTOTYPE_SLICE_PATH)
      )
    ).toEqual([]);

    expect(
      importSpecifiers.filter(
        (specifier) => !COMPONENT_META_ALLOWED_PREFIX_RE.test(specifier)
      )
    ).toEqual([]);
  });
});
