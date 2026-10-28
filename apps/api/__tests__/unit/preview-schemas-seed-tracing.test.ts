import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

/**
 * ISS-6804: proves the `/preview-schemas/seed` function actually CARRIES the
 * seed graph and the generated Prisma client it calls at runtime.
 *
 * The sibling `/preview-schemas/ensure` needs an explicit
 * `outputFileTracingIncludes` entry because it SPAWNS the Prisma CLI, and a
 * spawn is invisible to Next's tracer. The seed route is the opposite case: it
 * reaches the seed program through `await import("./seed/program")`, which the
 * tracer DOES follow — but only while the specifier stays a static string. Turn
 * it into a computed expression and the whole seed graph silently stops being
 * traced; the route then deploys green and dies MODULE_NOT_FOUND on the first
 * real seed, which is exactly the ISS-6403 failure the ensure route already
 * lived through. Nothing else in the suite would catch it: every unit test
 * resolves modules from the monorepo, where the file is present either way.
 *
 * The generated Prisma client is the second hop and the same story: the seed
 * program imports it lazily too, so both specifiers are pinned here.
 *
 * That asymmetry is why this file pins the SPECIFIER rather than a config glob.
 * The size half is already pinned next door —
 * `preview-schemas-ensure-tracing.test.ts` asserts `outputFileTracingIncludes`
 * has exactly one key, so the CLI's ~204 MB closure cannot be widened onto this
 * function without that test failing first.
 *
 * `preview-seed.ts` is TypeScript source, so it is parsed to an AST rather than
 * text-matched (AGENTS.md → Test Practices, no-raw-text-source-scan), matching
 * `preview-schemas-ensure-tracing.test.ts`.
 */

const DATABASE_SCRIPTS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "database",
  "scripts"
);

/**
 * Both hops the route takes into lazily-imported territory: the seed graph, and
 * the generated Prisma client the seed program builds its pool from. Each is a
 * dynamic import whose specifier must stay static for the tracer to collect it.
 */
const TRACED_LAZY_IMPORTS = [
  {
    file: join(DATABASE_SCRIPTS, "preview-seed.ts"),
    functionName: "runPreviewSeedInProcess",
    specifier: "./seed/program",
  },
  {
    file: join(DATABASE_SCRIPTS, "seed", "program.ts"),
    functionName: "createSeedPrisma",
    specifier: "../../generated/client",
  },
] as const;

const LOAD_TIMEOUT_MS = 30_000;

/** Every `import(...)` argument expression inside the named function. */
function readDynamicImportArguments(
  file: string,
  functionName: string
): ts.Expression[] {
  const found: ts.Expression[] = [];

  const collect = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      found.push(...node.arguments);
    }
    ts.forEachChild(node, collect);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      collect(node);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(
    ts.createSourceFile(
      file,
      readFileSync(file, "utf-8"),
      ts.ScriptTarget.Latest,
      true
    )
  );
  return found;
}

describe("preview schema seed route bundling", () => {
  it.each(TRACED_LAZY_IMPORTS)(
    "reaches $specifier through a statically traceable specifier",
    ({ file, functionName, specifier }) => {
      const args = readDynamicImportArguments(file, functionName);

      expect(args).toHaveLength(1);
      // A string LITERAL is the whole contract: `import(specifier)` with a
      // variable, a template with a substitution, or a concatenation leaves the
      // tracer nothing to follow and drops that module from the bundle.
      const [argument] = args;
      expect(ts.isStringLiteralLike(argument)).toBe(true);
      expect(ts.isStringLiteralLike(argument) && argument.text).toBe(specifier);
    }
  );

  it(
    "loads the seed program those specifiers resolve to",
    async () => {
      // The load half of the check, and it resolves from THIS app rather than
      // from `packages/database`: a traced specifier must also resolve to a
      // module that imports cleanly, so a seed graph that is present but broken
      // fails here rather than on the first stage seed.
      const program = await import("@repo/database/scripts/seed/program");

      expect(typeof program.runSeedProgram).toBe("function");
    },
    // Explicit, because loading the generated Prisma client cold runs several
    // seconds and the 5s default makes this a clock race. A specifier that does
    // not resolve rejects immediately, so nothing is masked by the headroom.
    LOAD_TIMEOUT_MS
  );
});
