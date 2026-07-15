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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolve paths relative to this test file's directory.
const AGENTS_DIR = join(import.meta.dirname, "..");
const WORKSPACE_DIR = join(AGENTS_DIR, "components", "workspace");
const LIB_DIR = join(AGENTS_DIR, "lib");

// Regex that matches actual import/require statements pointing at apps/prototypes.
// Matches both:
//   import ... from "apps/prototypes/..."
//   import ... from "../../../../../../apps/prototypes/..."  (relative traversal)
// Does NOT match comment lines that merely mention the path.
const PROTOTYPE_IMPORT_RE =
  /from\s+["'][^"']*apps\/prototypes[^"']*["']|require\s*\(\s*["'][^"']*apps\/prototypes[^"']*["']\s*\)/;

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
    const violations = listProductionSourceFiles(AGENTS_DIR)
      .map((filePath) => ({
        filePath: filePath.replace(`${AGENTS_DIR}/`, "agents/"),
        source: readFileSync(filePath, "utf8"),
      }))
      .filter(({ source }) => PROTOTYPE_IMPORT_RE.test(source));

    expect(violations).toEqual([]);
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
    const filePath = join(LIB_DIR, "component-meta.tsx");
    const source = readFileSync(filePath, "utf8");

    // Must not import from apps/prototypes (redundant with first test, explicit for clarity).
    expect(PROTOTYPE_IMPORT_RE.test(source)).toBe(false);

    // Collect all from-import specifiers.
    const importSpecifiers = [
      ...source.matchAll(/from\s+["']([^"']+)["']/g),
    ].map((m) => m[1]);

    const disallowed = importSpecifiers.filter(
      (spec) => !COMPONENT_META_ALLOWED_PREFIX_RE.test(spec)
    );

    expect(disallowed).toEqual([]);
  });
});
