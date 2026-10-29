import path from "node:path";
import ts from "typescript6";
import { parseTypeScriptFile } from "./ts-ast.js";

/** The Desktop main-process Vite config, relative to apps/desktop. */
export const MAIN_VITE_CONFIG = "vite.main.config.ts";
export const WORKSPACE_INLINE_BINDING = "WORKSPACE_INLINE";

/**
 * The `WORKSPACE_INLINE` packages `vite.main.config.ts` bundles from source,
 * read off the config's AST rather than restated, so a config-only change
 * reaches every suite that depends on the list (whitlockk review). Parsed rather
 * than imported because the config imports `vite` and reads `package.json` at
 * load. Returns `[]` when the binding is gone, which callers must treat as a
 * failure, not as "nothing is inlined".
 */
export function workspaceInlinePackages(desktopRoot: string): string[] {
  const config = parseTypeScriptFile(path.join(desktopRoot, MAIN_VITE_CONFIG));
  for (const statement of config.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === WORKSPACE_INLINE_BINDING &&
        declaration.initializer &&
        ts.isArrayLiteralExpression(declaration.initializer)
      ) {
        return declaration.initializer.elements
          .filter((element) => ts.isStringLiteralLike(element))
          .map((element) => element.text);
      }
    }
  }
  return [];
}
