/**
 * AST reader for the `DesktopServicesHost` object literal in `src/main/app.ts`.
 *
 * `app.ts` statically imports `electron`, so the host it builds cannot be
 * constructed in a node test — the same constraint that makes
 * `desktop-services-ast-helpers.ts` an AST guard. This is the sanctioned
 * `ts.createSourceFile` alternative to a raw text scan
 * (`scripts/lint/rules/no-raw-text-source-scan.ts`).
 *
 * Separate from the `desktop-services` reader because the shape is different:
 * there the target is an argument to a named call, here it is a property on an
 * object literal returned from a method, so there is no callee to key on.
 */
import { readFileSync } from "node:fs";
import type { Node } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isIdentifier,
  isPropertyAssignment,
  ScriptKind,
  ScriptTarget,
} from "typescript6";

/**
 * The initializer of the first `name:` property assignment in `app.ts`.
 *
 * The host accessor names are unique in that file, so the first match is the
 * host's — a narrower "find the host literal first" walk would have to key on
 * the literal's shape, which changes far more often than the accessor name.
 */
export function appHostAccessor(name: string): Node | undefined {
  return mainModuleAccessor("app.ts", name);
}

/**
 * The same read against any other `src/main/**` module that a node test cannot
 * load — `desktop-ipc-registration.ts` builds its handler deps behind a static
 * `electron` import too. Shared rather than re-walked per suite for the reason
 * `desktop-services-ast-helpers.ts` gives: a second copy of this walk is a
 * second definition of "what that literal passes".
 *
 * Keyed on the property name alone, so a caller must confirm the name it asks
 * for is unique in that file before trusting the first match.
 */
export function mainModuleAccessor(
  relativePath: string,
  name: string
): Node | undefined {
  const path = new URL(`../src/main/${relativePath}`, import.meta.url);
  const source = createSourceFile(
    relativePath,
    readFileSync(path, "utf-8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );

  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (
      !found &&
      isPropertyAssignment(node) &&
      isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node.initializer;
    }
    forEachChild(node, visit);
  };
  forEachChild(source, visit);
  return found;
}
