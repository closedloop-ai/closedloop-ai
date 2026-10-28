/**
 * The `stories` array of `.storybook/main.ts`, read from its AST — plus the
 * other repo paths that config reads (`storybookConfigReadPaths`).
 *
 * Hoisted out of `story-glob-parity.test.ts` (ISS-5697 review, whitlockk) because a
 * SECOND guard now has to answer a question about the same list:
 * `story-glob-parity` asks whether the Vitest sweep globs everything Storybook
 * indexes, and `app-core-harness-single-mount` asks whether its `STORY_ROOTS`
 * walk covers it. Two readers of one config, so one reader.
 *
 * `main.ts` cannot simply be imported — it calls `fileURLToPath(import.meta.url)`,
 * which throws under Vitest's transform — and it must not be regex-scanned:
 * `scripts/lint/rules/no-raw-text-source-scan.ts` bans text-scanning
 * implementation source and points at `ts.createSourceFile`, which is what this
 * uses.
 *
 * The `stories`-array read itself now lives in `../../scripts/story-globs.mjs`
 * and this delegates to it (ISS-10399). The catalog collectors are a THIRD
 * consumer of that array and are plain Node scripts, which cannot import this
 * `.ts` file — so the reader moved to the side that both can reach, and the
 * "two readers of one config, so one reader" rule above still holds. A brief
 * period with two readers had already cost something: only this one knew the
 * `{ directory, files }` entry form.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import {
  storybookDir,
  storybookMainPath,
  storyConfigPatterns,
} from "../../scripts/story-globs.mjs";

// Re-exported from the reader rather than recomputed: two hand-maintained
// relative paths to one canonical file diverge the moment either directory
// moves, and each side then reads a different `main.ts` (review, ISS-10399).
export const STORYBOOK_DIR: string = storybookDir;
export const STORYBOOK_MAIN_PATH: string = storybookMainPath;

/**
 * Every config-relative pattern in `main.ts`'s `stories` array, in declaration
 * order. Resolve against {@link STORYBOOK_DIR} to compare with anything else.
 *
 * `mainPath` defaults to the real config; the helper's own test hands it a
 * synthetic file to pin the object-entry and unreadable-entry shapes.
 */
export function storybookStoryPatterns(
  mainPath: string = STORYBOOK_MAIN_PATH
): string[] {
  return storyConfigPatterns(mainPath);
}

/** Walks every node of a TypeScript source file. */
export function visitSource(
  filePath: string,
  visitor: (node: ts.Node) => void
): void {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const visit = (node: ts.Node): void => {
    visitor(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/**
 * The repo paths `main.ts` reads outside its `stories` array, absolute: each
 * `join(repoRoot, …)` call (the alias targets it declares itself) and each
 * `staticDirs` source. Refuses a form it cannot resolve, like the reader above.
 */
export function storybookConfigReadPaths(
  mainPath: string = STORYBOOK_MAIN_PATH
): string[] {
  const configDir = path.dirname(mainPath);
  // `main.ts`'s own `repoRoot`: `new URL("../../..", import.meta.url)`.
  const repoRoot = path.resolve(configDir, "../../..");
  const paths: string[] = [];
  visitSource(mainPath, (node) => {
    if (isRepoRootJoin(node)) {
      const parts = node.arguments.slice(1).filter(ts.isStringLiteral);
      if (parts.length !== node.arguments.length - 1) {
        throw new Error(
          `cannot resolve \`${node.getText()}\` in ${mainPath} — the hash-coverage check cannot be verified`
        );
      }
      paths.push(path.join(repoRoot, ...parts.map((part) => part.text)));
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "staticDirs" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        paths.push(path.resolve(configDir, staticDirSource(element, mainPath)));
      }
    }
  });
  return paths;
}

function isRepoRootJoin(node: ts.Node): node is ts.CallExpression {
  if (!(ts.isCallExpression(node) && ts.isIdentifier(node.expression))) {
    return false;
  }
  const [first] = node.arguments;
  return (
    node.expression.text === "join" &&
    first !== undefined &&
    ts.isIdentifier(first) &&
    first.text === "repoRoot"
  );
}

/** Storybook accepts a bare directory string or a `{ from, to }` object. */
function staticDirSource(element: ts.Expression, mainPath: string): string {
  if (ts.isStringLiteral(element)) {
    return element.text;
  }
  if (ts.isObjectLiteralExpression(element)) {
    for (const property of element.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "from" &&
        ts.isStringLiteral(property.initializer)
      ) {
        return property.initializer.text;
      }
    }
  }
  throw new Error(
    `cannot resolve a \`staticDirs\` entry \`${element.getText()}\` in ${mainPath} — the hash-coverage check cannot be verified`
  );
}
