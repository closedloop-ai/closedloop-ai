import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript6";
import { afterAll, describe, expect, it } from "vitest";
import type { SyncedAgentSession } from "../../desktop/src/main/agent-sync/agent-session-sync-contract.js";
import { sumTokenUsage } from "../../desktop/src/main/session/session-usage-totals.js";

/**
 * ISS-9686: the API tier must be able to name a desktop session fold so a test
 * can assert the Local (desktop) population agrees with the Cloud one for the
 * same target — the Local-vs-Cloud arm of ISS-9624.
 *
 * Before this change it could not. Every desktop fold types its input as
 * `SyncedAgentSession`, and `agent-session-sync-contract.ts` re-exported two
 * types from `agent-session-sync-source.ts`, which type-imports
 * `agent-session-attribution.ts`, which VALUE-imports
 * `server/operations/symphony-utils.ts`. A type-only import still roots a file
 * in `tsc`, so naming the contract from `apps/api` compiled 220 desktop files
 * including 29 under `src/server/`, and failed with 15 errors. Exactly one file
 * read those two types by that path; it now reads them from
 * `agent-session-sync-source.ts`, where every other consumer already did.
 * Deleting the re-export leaves 5 desktop files, none under `src/server/`.
 *
 * The Engineer operations tree spawns local CLI processes and must stay in
 * `apps/desktop/src/server/operations/` (root AGENTS.md). This guard is the
 * one-way direction of that rule: the fold moves away from Engineer, and this
 * test fails if Engineer becomes reachable from the fold again.
 *
 * The first test is the one that was previously impossible — it does not merely
 * name the fold, it runs it, so the import cannot be elided as type-only. The
 * reachability pair below is deliberately two tests: the negative alone is
 * vacuous if the walker cannot see reachability at all, so the sibling asserts
 * the SAME walker DOES reach `symphony-utils.ts` from the attribution module
 * whose value import roots it.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

// Written as an independent literal, never derived from a tsconfig, lint config,
// or the module graph this test polices — deleting an entry there must not be
// able to silently satisfy this assertion.
const ENGINEER_OPERATIONS_ROOT = `${join("apps", "desktop", "src", "server")}${sep}`;

const SESSION_FOLD_ENTRY = join(
  REPO_ROOT,
  "apps/desktop/src/main/session/session-usage-totals.ts"
);
const ATTRIBUTION_ENTRY = join(
  REPO_ROOT,
  "apps/desktop/src/main/agent-sync/agent-session-attribution.ts"
);
const SYNC_SOURCE_ENTRY = join(
  REPO_ROOT,
  "apps/desktop/src/main/agent-sync/agent-session-sync-source.ts"
);
const SYMPHONY_UTILS = join(
  REPO_ROOT,
  "apps/desktop/src/server/operations/symphony-utils.ts"
);

// Mirrors the extension handling in `scripts/lint/critic-gates-import-closure.ts`,
// which carries these lists because a specifier this walker cannot resolve is
// indistinguishable from one that resolves to nothing — a silently dropped edge
// reads as compliance. `unresolved` below is the channel that makes it loud.
const STRIPPABLE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];
const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

function candidatePaths(specifier: string, fromDir: string): string[] {
  const base = resolve(fromDir, specifier);
  const stripped = STRIPPABLE_EXTENSIONS.find((extension) =>
    base.endsWith(extension)
  );
  const roots =
    stripped === undefined ? [base] : [base.slice(0, -stripped.length), base];

  return roots.flatMap((root) => [
    root,
    ...MODULE_EXTENSIONS.map((extension) => `${root}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => `${root}/index${extension}`),
  ]);
}

function resolveRelativeImport(
  specifier: string,
  fromFile: string
): string | null {
  return (
    candidatePaths(specifier, dirname(fromFile)).find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile()
    ) ?? null
  );
}

function staticEdgeSpecifier(node: ts.Node): string | null {
  if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) {
    return null;
  }
  const specifier = node.moduleSpecifier;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : null;
}

// `type X = import("./y.js").Z` is the third spelling of a type-only edge, and
// like `import type` it is erased at runtime while still rooting the target in
// `tsc`. A walker blind to it would miss exactly the defect class this guard
// exists for, so it is matched alongside `import ... =` and dynamic `import()`.
function typePositionSpecifier(node: ts.Node): string | null {
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal)
  ) {
    return node.argument.literal.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteral(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  return null;
}

// `isStringLiteralLike`, not `isStringLiteral`: a static `import(`./x.js`)` is a
// `NoSubstitutionTemplateLiteral`, so the narrower predicate drops that edge
// silently — and a dropped edge is what this guard reads as compliance.
function dynamicImportSpecifier(node: ts.Node): string | null {
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length > 0 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return null;
}

// The module graph is read as an AST, not text-matched (AGENTS.md → Test
// Practices, no-raw-text-source-scan).
function moduleSpecifiersOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    true
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    const specifier =
      staticEdgeSpecifier(node) ??
      typePositionSpecifier(node) ??
      dynamicImportSpecifier(node);
    if (specifier !== null) {
      specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return specifiers;
}

type ImportGraph = {
  files: Set<string>;
  /** Relative specifiers the walker could not resolve to a file on disk. */
  unresolved: string[];
};

function walkImportGraph(entry: string): ImportGraph {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || files.has(current)) {
      continue;
    }
    files.add(current);
    for (const specifier of moduleSpecifiersOf(current)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolveRelativeImport(specifier, current);
      if (resolved === null) {
        unresolved.push(`${relative(REPO_ROOT, current)} -> ${specifier}`);
      } else if (!files.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return { files, unresolved };
}

function engineerTreeHits(graph: ImportGraph): string[] {
  return [...graph.files]
    .map((file) => relative(REPO_ROOT, file))
    .filter((file) => file.startsWith(ENGINEER_OPERATIONS_ROOT))
    .sort();
}

describe("desktop session fold reachability from apps/api", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "fold-walker-"));

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("runs the desktop token-total fold from the API tier", () => {
    const session = {
      tokenUsageByModel: [
        {
          model: "claude-opus-4",
          inputTokens: 10,
          outputTokens: 3,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
          estimatedCostUsd: 0.25,
        },
        {
          model: "claude-sonnet-4",
          inputTokens: 4,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: null,
        },
      ],
    } as unknown as SyncedAgentSession;

    expect(sumTokenUsage(session)).toEqual({
      inputTokens: 14,
      outputTokens: 4,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      estimatedCost: 0.25,
      // ISS-11226: one of the two rows carried a real cost, so the sum is
      // PARTIAL — a figure, but not a complete measurement of this session.
      costMeasuredMembers: 1,
      costMembers: 2,
    });
  });

  it("does not reach the Engineer operations tree from the session fold", () => {
    const graph = walkImportGraph(SESSION_FOLD_ENTRY);

    // A specifier the walker cannot resolve is a dropped edge, and a dropped
    // edge is indistinguishable from an absent one — assert it stayed empty
    // before reading anything into the hit list below.
    expect(graph.unresolved).toEqual([]);
    expect(engineerTreeHits(graph)).toEqual([]);
  });

  // Siblings of the assertion above: without them, a walker that resolves
  // nothing (a bad path candidate table, a missed AST node kind) reports an
  // empty hit list for every entry and the guard passes while seeing nothing.
  // The second entry is two hops from `symphony-utils.ts`, so it pins that the
  // walk is transitive and not just direct-import depth.
  //
  // These deliberately do NOT assert `unresolved` is empty, and the asymmetry
  // with the negative case above is the point. Both closures reach
  // `database/prisma-client.ts`, whose `./generated/client.js` is gitignored and
  // is NOT generated by the `apps/api` PR job — so the assertion would fail in
  // CI while passing on any machine that ran `pnpm -C apps/desktop db:generate`.
  // It is also not load-bearing here: a dropped edge can only lose a hit, so it
  // could fail this assertion but never let it pass wrongly. Above, where the
  // expectation is emptiness, a dropped edge WOULD read as compliance.
  //
  // The explicit timeout is required rather than inherited: when that generated
  // client is present the closure includes ~70 machine-generated modules that
  // are parsed to an AST, which is far past Vitest's default budget.
  it.each([
    ["directly importing module", ATTRIBUTION_ENTRY],
    ["module two hops above it", SYNC_SOURCE_ENTRY],
  ])(
    "reaches the Engineer operations tree from the %s",
    (_label, entry) => {
      expect(engineerTreeHits(walkImportGraph(entry))).toContain(
        relative(REPO_ROOT, SYMPHONY_UTILS)
      );
    },
    30_000
  );

  // The walker's own blind-spot control. Every assertion above reads the real
  // tree, where no edge happens to be spelled with backticks today — so a
  // predicate that drops that spelling leaves both `unresolved` and the hit list
  // empty and the guard passes having seen less than it thinks. The fixture is
  // synthetic because the point is the SPELLING, not any real module: it must
  // stay red for `isStringLiteral` no matter how the desktop tree is written.
  it("follows a dynamic import written as a template literal", () => {
    const entry = join(fixtureRoot, "entry.ts");
    const target = join(fixtureRoot, "target.ts");
    writeFileSync(
      entry,
      "export const load = () => import(`./target.js`);\n",
      "utf-8"
    );
    writeFileSync(target, "export const marker = 1;\n", "utf-8");

    const graph = walkImportGraph(entry);

    expect(graph.unresolved).toEqual([]);
    expect([...graph.files]).toContain(target);
  });
});
