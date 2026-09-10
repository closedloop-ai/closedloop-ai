/**
 * The `stories` array of `.storybook/main.ts`, read from its AST.
 *
 * Hoisted out of `story-glob-parity.test.ts` (ISS-5697 review, wongk) because a
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
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

export const STORYBOOK_DIR = path.resolve(
  import.meta.dirname,
  "../../.storybook"
);
export const STORYBOOK_MAIN_PATH = path.join(STORYBOOK_DIR, "main.ts");

/**
 * Every config-relative pattern in `main.ts`'s `stories` array, in declaration
 * order. Resolve against {@link STORYBOOK_DIR} to compare with anything else.
 */
export function storybookStoryPatterns(): string[] {
  const patterns: string[] = [];
  visitSource(STORYBOOK_MAIN_PATH, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "stories" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        patterns.push(storyEntryPath(element));
      }
    }
  });

  return patterns;
}

/** Storybook accepts a bare glob string or a `{ directory, files }` object. */
function storyEntryPath(element: ts.Expression): string {
  if (ts.isStringLiteral(element)) {
    return element.text;
  }
  if (ts.isObjectLiteralExpression(element)) {
    const read = (key: string): string => {
      for (const property of element.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === key &&
          ts.isStringLiteral(property.initializer)
        ) {
          return property.initializer.text;
        }
      }
      return "";
    };
    return path.posix.join(read("directory"), read("files"));
  }
  throw new Error(
    `cannot resolve a story root from \`stories\` entry \`${element.getText()}\` ` +
      `in ${STORYBOOK_MAIN_PATH} — the sweep's glob parity cannot be verified`
  );
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

export const STORYBOOK_PREVIEW_PATH = path.join(STORYBOOK_DIR, "preview.tsx");

/** A storySort `order` array: strings, and arrays of the same, to any depth. */
export type StorySortOrder = readonly (string | StorySortOrder)[];

/**
 * `parameters.options.storySort.order` from `preview.tsx`.
 *
 * Storybook's indexer reads this array STATICALLY, so it is literal by
 * construction: hoisting a shared list into a `const` and referencing it here
 * fails the build with "Unexpected 'ELEMENT_KINDS'. Parameter
 * 'options.storySort'". Being literal is also why it can drift from the story
 * corpus without anything failing, which is what
 * `story-sort-covers-taxonomy.test.ts` uses this to check.
 */
export function storybookStorySortOrder(): StorySortOrder {
  let order: StorySortOrder | null = null;

  visitSource(STORYBOOK_PREVIEW_PATH, (node) => {
    if (
      order === null &&
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "order" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      order = readOrderArray(node.initializer);
    }
  });

  if (order === null) {
    throw new Error(
      `no \`order\` array found in ${STORYBOOK_PREVIEW_PATH} — if storySort moved, update the guard rather than deleting it`
    );
  }

  return order;
}

function readOrderArray(node: ts.ArrayLiteralExpression): StorySortOrder {
  return node.elements.map((element) => {
    if (ts.isStringLiteral(element)) {
      return element.text;
    }
    if (ts.isArrayLiteralExpression(element)) {
      return readOrderArray(element);
    }
    throw new Error(
      `storySort.order contains a non-literal entry (${element.getText()}). Storybook's indexer rejects those, so this should be unreachable.`
    );
  });
}
