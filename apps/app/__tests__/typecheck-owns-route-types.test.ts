import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

/**
 * ISS-5133: `next.config.ts` sets `typescript.ignoreBuildErrors`, so the Vercel
 * build no longer type-checks `apps/app`. That is only safe while something
 * else checks the SAME file set — including the generated
 * `.next/types/validator.ts`, which validates every page/layout/route-handler
 * signature against its route's `params`.
 *
 * `apps/app/tsconfig.json` already globs `.next/types/**\/*.ts`, but that glob
 * matches nothing in a cold checkout, so the required `typecheck` CI job could
 * not see the validator until the `typecheck` script started running
 * `next typegen` first. The two changes are load-bearing together and useless
 * apart: drop the typegen step and route-signature validation silently loses
 * its last owner, with nothing going red. This test is that guard.
 */

const APP_ROOT = join(import.meta.dirname, "..");
const NEXT_CONFIG_PATH = join(APP_ROOT, "next.config.ts");
const PACKAGE_JSON_PATH = join(APP_ROOT, "package.json");
const TSCONFIG_PATH = join(APP_ROOT, "tsconfig.json");
const GENERATED_TYPES_GLOB = ".next/types/**/*.ts";

// `next.config.ts` is TypeScript source, so it is parsed to an AST rather than
// text-matched (AGENTS.md → Test Practices, no-raw-text-source-scan).
function readIgnoreBuildErrors(): boolean | undefined {
  const source = ts.createSourceFile(
    NEXT_CONFIG_PATH,
    readFileSync(NEXT_CONFIG_PATH, "utf-8"),
    ts.ScriptTarget.Latest,
    true
  );

  let found: boolean | undefined;

  const visit = (node: ts.Node): void => {
    // Matches `nextConfig.typescript = { ignoreBuildErrors: <literal> }`.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "typescript" &&
      ts.isObjectLiteralExpression(node.right)
    ) {
      for (const property of node.right.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "ignoreBuildErrors"
        ) {
          found = property.initializer.kind === ts.SyntaxKind.TrueKeyword;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

function readTsconfigInclude(): string[] {
  // tsconfig.json is config/data, so a plain parse is allowed here (the AST rule
  // covers TypeScript source). It carries comments in this repo's tooling, but
  // apps/app/tsconfig.json is strict JSON today; if that changes, switch to a
  // JSONC parse rather than deleting the assertion.
  const tsconfig = JSON.parse(readFileSync(TSCONFIG_PATH, "utf-8")) as {
    include?: string[];
  };
  return tsconfig.include ?? [];
}

function readTypecheckScript(): string {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as {
    scripts?: Record<string, string>;
  };
  const script = manifest.scripts?.typecheck;
  if (!script) {
    throw new Error("apps/app/package.json must define a `typecheck` script");
  }
  return script;
}

describe("route-type validation has an owner outside the build", () => {
  it("skips type-checking during `next build`", () => {
    expect(readIgnoreBuildErrors()).toBe(true);
  });

  it("generates route types before type-checking, so the validator is covered", () => {
    expect(readTypecheckScript()).toContain("next typegen");
  });

  it("keeps the generated route types in the tsc program", () => {
    // The third load-bearing leg. typegen can run and `tsc` can pass while
    // covering nothing, if this glob ever leaves `include` — the generated
    // files would simply not be part of the program, silently and greenly.
    expect(readTsconfigInclude()).toContain(GENERATED_TYPES_GLOB);
  });

  it("still runs tsc, and runs it after typegen", () => {
    const script = readTypecheckScript();

    expect(script).toContain("tsc --noEmit");
    // Order matters: tsc reads `.next/types`, so typegen has to land first.
    expect(script.indexOf("next typegen")).toBeLessThan(
      script.indexOf("tsc --noEmit")
    );
  });
});
