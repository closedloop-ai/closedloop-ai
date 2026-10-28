/**
 * Which file extensions count as a story, read from `.storybook/main.ts`.
 *
 * That config's `stories` array is the only place this repo states the answer,
 * and the catalog collectors have to agree with it. A story written in an
 * indexed extension the collectors reject is rendered by Storybook and executed
 * by the Vitest sweep while `catalog:sync`, taxonomy classification and
 * `validate:catalog` never see it — no error, no warning, the catalog simply
 * does not know it exists (ISS-10399). So the collectors DERIVE their predicate
 * from that array instead of restating it; a second hand-maintained list is the
 * divergence this module exists to make impossible.
 *
 * Read through `ts.createSourceFile`, not a text scan: `main.ts` cannot be
 * imported from a plain Node script (it pulls in the Storybook/Vite config
 * graph and resolves addon packages), and `scripts/lint/rules/no-raw-text-source-scan.ts`
 * points at the AST for exactly this shape of read.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

export const storybookDir = path.join(import.meta.dirname, "..", ".storybook");
export const storybookMainPath = path.join(storybookDir, "main.ts");

/** Trailing `@(a|b|c)` extension group, the form Storybook globs are written in. */
const braceGroupSuffixRegex = /@\(([^)]+)\)$/;
/** A single trailing extension, for a glob written without a brace group. */
const plainExtensionSuffixRegex = /\.([A-Za-z0-9]+)$/;
/** Whether a pattern segment carries any glob metacharacter at all. */
const globMetaCharacterRegex = /[*?[\]{}@]/;
/** Regex metacharacters to escape when turning one pattern segment into a regex. */
const regexSpecialCharacterRegex = /[.+^${}()|[\]\\]/g;
const singleStarRegex = /\*/g;
const questionMarkRegex = /\?/g;
/** The marker that separates a story glob from the `*.mdx` docs glob. */
const storyInfix = ".stories.";

/**
 * One entry per story glob in `main.ts`: the segments of the directory portion
 * it scans — wildcards intact — and the extensions it indexes there. The
 * `*.mdx` docs glob is not a story glob and is not included.
 *
 * The wildcards are kept rather than truncated away at the first one. Two globs
 * that share everything before their first wildcard still target different
 * subtrees: `packages/app/*<!---->/components/**` and a
 * `packages/app/*<!---->/examples/**` beside it both begin at `packages/app`,
 * and collapsing them to that prefix would answer `examples`' extensions for a
 * `components` directory — cataloguing files Storybook does not index there
 * (review, PR #8006).
 */
export function storyGlobs(mainPath = storybookMainPath) {
  const globs = [];

  for (const pattern of storyConfigPatterns(mainPath)) {
    const absolute = path.resolve(path.dirname(mainPath), pattern);
    if (!path.basename(absolute).includes(storyInfix)) {
      continue;
    }
    globs.push({
      dirSegments: path.dirname(absolute).split(path.sep),
      extensions: globExtensions(absolute, mainPath),
    });
  }

  if (globs.length === 0) {
    throw new Error(
      `no \`*${storyInfix}*\` glob found in the \`stories\` array of ${mainPath} — the story collectors have nothing to derive their extension set from`
    );
  }

  return globs;
}

/** Every extension any story glob indexes, sorted. */
export function storyFileExtensions(mainPath = storybookMainPath) {
  const extensions = new Set();
  for (const glob of storyGlobs(mainPath)) {
    for (const extension of glob.extensions) {
      extensions.add(extension);
    }
  }
  return [...extensions].sort();
}

/**
 * The extensions indexed under `dirPath` — the union over every story glob that
 * can index a file at or below it, matched segment by segment against the
 * glob's wildcards rather than against a truncated static prefix. Throws rather
 * than returning an empty set for a directory no glob covers: a collector
 * handed `[]` would walk the tree and return nothing, which reads exactly like a
 * clean run.
 *
 * Ask it about the directory a collector actually WALKS, not an ancestor. A
 * glob under an ancestor can still reach below it, so an ancestor's answer is
 * the union of every subtree beneath it, which is wider than any one of them.
 */
export function storyExtensionsForDirectory(
  dirPath,
  mainPath = storybookMainPath
) {
  const dirSegments = path.resolve(dirPath).split(path.sep);
  const extensions = new Set();

  for (const glob of storyGlobs(mainPath)) {
    if (globCanIndexUnder(dirSegments, glob.dirSegments)) {
      for (const extension of glob.extensions) {
        extensions.add(extension);
      }
    }
  }

  if (extensions.size === 0) {
    throw new Error(
      `${dirSegments.join(path.sep)} is under no story glob in ${mainPath} — Storybook indexes nothing there, so collecting stories from it would catalog stories that never render`
    );
  }

  return [...extensions].sort();
}

/** Matches `.stories.<ext>` at the end of a filename, for the given extensions. */
export function storyFileSuffixPattern(extensions) {
  if (extensions.length === 0) {
    throw new Error(
      "refusing to build a story-file pattern from an empty extension set — it would match nothing and report a clean run"
    );
  }
  return new RegExp(`\\.stories\\.(?:${extensions.join("|")})$`);
}

/**
 * Every config-relative pattern in `main.ts`'s `stories` array, in declaration
 * order — the ONE reader of that array.
 *
 * `__tests__/helpers/storybook-config-source.ts` delegates here rather than
 * walking the AST a second time. That helper's own docstring is the reason
 * ("two readers of one config, so one reader"), and a second reader had already
 * cost something: it taught the `{ directory, files }` entry form and this one
 * did not, so converting any `stories` entry to that legal Storybook shape would
 * have broken `catalog:sync` and `validate:catalog` at import while the sibling
 * guards stayed green. The reader lives in the `.mjs` because a plain Node
 * script cannot import the `.ts` helper, and a `.ts` test can import this.
 */
export function storyConfigPatterns(mainPath = storybookMainPath) {
  const source = ts.createSourceFile(
    mainPath,
    readFileSync(mainPath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const patterns = [];

  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "stories" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        patterns.push(storyEntryPath(element, mainPath));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return patterns;
}

/** Storybook accepts a bare glob string or a `{ directory, files }` object. */
function storyEntryPath(element, mainPath) {
  if (ts.isStringLiteral(element)) {
    return element.text;
  }
  if (ts.isObjectLiteralExpression(element)) {
    const read = (key) => {
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
      `in ${mainPath} — the sweep's glob parity cannot be verified`
  );
}

/** The extensions one glob indexes: its `@(a|b|c)` group, or its single suffix. */
function globExtensions(absolutePattern, mainPath) {
  const braceMatch = braceGroupSuffixRegex.exec(absolutePattern);
  if (braceMatch) {
    return braceMatch[1].split("|");
  }

  const plainMatch = plainExtensionSuffixRegex.exec(absolutePattern);
  if (plainMatch) {
    return [plainMatch[1]];
  }

  throw new Error(
    `story glob \`${absolutePattern}\` in ${mainPath} ends in no extension — the story collectors cannot tell what it indexes`
  );
}

/** Whether one pattern segment matches one real directory-name segment. */
function segmentMatches(patternSegment, segment) {
  if (!globMetaCharacterRegex.test(patternSegment)) {
    return patternSegment === segment;
  }
  const source = patternSegment
    .replace(regexSpecialCharacterRegex, "\\$&")
    .replace(singleStarRegex, "[^/]*")
    .replace(questionMarkRegex, ".");
  return new RegExp(`^${source}$`).test(segment);
}

/**
 * Whether a glob whose directory portion is `patternSegments` can index a file
 * at or below the directory `dirSegments`.
 *
 * Two directions, both of which are a yes. The directory is inside the glob's
 * scanned area (every dir segment matched, the pattern may continue through
 * `**`), or the directory is an ANCESTOR of that area — `packages/app` for a
 * `packages/app/*<!---->/components/**` glob — in which case the glob still
 * reaches below it.
 */
function globCanIndexUnder(dirSegments, patternSegments) {
  if (dirSegments.length === 0) {
    return true;
  }
  if (patternSegments.length === 0) {
    return false;
  }

  const [patternSegment, ...restPattern] = patternSegments;
  if (patternSegment === "**") {
    return (
      globCanIndexUnder(dirSegments, restPattern) ||
      globCanIndexUnder(dirSegments.slice(1), patternSegments)
    );
  }

  return (
    segmentMatches(patternSegment, dirSegments[0]) &&
    globCanIndexUnder(dirSegments.slice(1), restPattern)
  );
}
