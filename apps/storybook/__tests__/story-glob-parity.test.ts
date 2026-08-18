/**
 * ISS-5287 — keeps the sweep's coverage tied to Storybook's own index.
 *
 * `story-sweep.test.tsx` must hardcode its globs, because Vite resolves
 * `import.meta.glob` at transform time and cannot read a runtime value. That
 * makes drift possible in two directions that matter: someone adds a glob to
 * `.storybook/main.ts` that the sweep never picks up, or someone deletes one
 * from the sweep. Either way Storybook indexes stories that nothing runs, and
 * the suite still reports green.
 *
 * So BOTH sides are read from source rather than restated here. Neither
 * `.storybook/main.ts` nor the sweep can simply be imported — `main.ts` calls
 * `fileURLToPath(import.meta.url)`, which throws under Vitest's transform, and
 * importing the sweep would drag its top-level await, and the whole story
 * corpus, into this guard. Both are read from their AST instead, which is also
 * the form this repo sanctions: `scripts/lint/rules/no-raw-text-source-scan.ts`
 * bans regex-scanning implementation source and points at `ts.createSourceFile`.
 * The `main.ts` half of that reader lives in `./helpers/storybook-config-source`
 * — ISS-5697 gave `app-core-harness-single-mount.test.ts` its own parity check
 * against the same `stories` array, and two guards asking about one config
 * should read it through one reader.
 *
 * Whole patterns are compared, not their directory prefixes. An earlier version
 * compared prefixes truncated at the first wildcard, which collapsed every
 * `packages/app/*<!-- -->/…` pattern onto one root and left a new indexed
 * subdirectory under that wildcard invisible. Comparing fully-resolved patterns
 * needs Storybook's `@(a|b|c)` brace groups expanded — it writes one entry per
 * root where the sweep lists each extension separately — and that expansion is
 * what makes the extension set guarded too, rather than a separate assertion.
 *
 * Containment, not equality: the sweep globbing MORE than Storybook indexes is
 * fine (a pattern matching nothing is free, and the sweep deliberately globs all
 * five extensions at every root), whereas globbing less means stories that never
 * run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import {
  STORYBOOK_DIR,
  storybookStoryPatterns,
  visitSource,
} from "./helpers/storybook-config-source";

const TESTS_DIR = import.meta.dirname;
const SWEEP_PATH = path.join(TESTS_DIR, "story-sweep.test.tsx");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const TURBO_JSON_PATH = path.join(REPO_ROOT, "turbo.json");
const SWEEP_TASK = "storybook#test";
/** Trailing `@(a|b|c)` brace group in a Storybook glob pattern. */
const BRACE_GROUP_SUFFIX = /@\(([^)]+)\)$/;

describe("story sweep glob parity with .storybook/main.ts", () => {
  it("globs every story pattern Storybook indexes", () => {
    const indexed = expandPatterns(
      storybookStoryPatterns().filter((pattern) => !pattern.endsWith(".mdx")),
      STORYBOOK_DIR
    );
    const swept = new Set(expandPatterns(sweepPatterns(), TESTS_DIR));

    const missing = indexed.filter((pattern) => !swept.has(pattern));
    expect(
      missing,
      `Storybook indexes ${missing.join(", ")} but story-sweep.test.tsx does not glob it — those stories would never run while the suite stayed green`
    ).toEqual([]);
  });

  it("keeps the sweep task uncacheable", () => {
    // A green task and a task that ran are not the same thing, and this task's
    // real inputs are the transitive import graph of every story it composes:
    // `packages/app`, `packages/design-system` (which has no `test` task for
    // `^test` to hash), and `apps/desktop`'s renderer AND `src/shared` — reached
    // by filesystem glob, not by workspace dependency. Enumerating that in
    // `inputs` cannot be kept honest; each new import silently widens it and the
    // sweep replays a cached pass over stories it never executed. So the sweep
    // does not cache, and this asserts nobody re-adds caching without replacing
    // that reasoning.
    const turbo = JSON.parse(readFileSync(TURBO_JSON_PATH, "utf8")) as {
      tasks?: Record<string, { cache?: boolean }>;
    };
    const task = turbo.tasks?.[SWEEP_TASK];

    expect(task, `turbo.json declares no \`${SWEEP_TASK}\` task`).toBeDefined();
    expect(
      task?.cache,
      `\`${SWEEP_TASK}\` must set \`"cache": false\` — its inputs are the whole story corpus's import graph, which no \`inputs\` list can track, so a cached pass cannot be trusted to have run the changed story`
    ).toBe(false);
  });

  it("reads non-empty pattern arrays out of both sources", () => {
    // Guards the guard: if either AST shape changed and nothing parsed, the
    // containment assertion above would pass vacuously.
    expect(storybookStoryPatterns().length).toBeGreaterThan(0);
    expect(sweepPatterns().length).toBeGreaterThan(0);
  });
});

/**
 * The literal patterns passed to the sweep's `import.meta.glob(...)`. Read from
 * source so deleting one turns this guard red — restating them here would make
 * the assertion compare two copies of the same hand-maintained list.
 */
function sweepPatterns(): string[] {
  const patterns: string[] = [];
  visitSource(SWEEP_PATH, (node) => {
    if (
      !(
        ts.isCallExpression(node) &&
        node.expression.getText() === "import.meta.glob"
      )
    ) {
      return;
    }
    const [first] = node.arguments;
    if (!(first && ts.isArrayLiteralExpression(first))) {
      throw new Error(
        `expected \`import.meta.glob\` in ${SWEEP_PATH} to take an array literal — ` +
          "the sweep's glob coverage cannot be verified"
      );
    }
    for (const element of first.elements) {
      if (!ts.isStringLiteral(element)) {
        throw new Error(
          `non-literal glob \`${element.getText()}\` in ${SWEEP_PATH} — ` +
            "Vite resolves these at transform time, so they must stay literal"
        );
      }
      patterns.push(element.text);
    }
  });

  return patterns;
}

/**
 * Resolves each pattern against its own base directory and expands a trailing
 * `@(a|b|c)` extension group, so a Storybook entry and the sweep's per-extension
 * entries become directly comparable strings. Wildcard segments are preserved
 * verbatim — only `.`/`..` are normalized away.
 */
function expandPatterns(patterns: string[], fromDir: string): string[] {
  const expanded: string[] = [];
  for (const pattern of patterns) {
    const braceMatch = BRACE_GROUP_SUFFIX.exec(pattern);
    if (braceMatch) {
      const stem = pattern.slice(0, braceMatch.index);
      for (const extension of braceMatch[1].split("|")) {
        expanded.push(path.resolve(fromDir, `${stem}${extension}`));
      }
      continue;
    }
    expanded.push(path.resolve(fromDir, pattern));
  }
  return expanded;
}
