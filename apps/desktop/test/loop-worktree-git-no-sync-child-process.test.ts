/**
 * ISS-6132 guard — the loop worktree lifecycle must stay free of synchronous
 * child processes.
 *
 * The behavioural regression lives in `loop-worktree-git-main-thread.test.ts`.
 * This file guards the seam itself: gateway operations run on the Electron main
 * thread, so a single `execSync`/`execFileSync`/`spawnSync` reintroduced into
 * the worktree provisioning path silently restores the whole-app freeze, and a
 * behavioural test only covers the call sites it happens to drive.
 *
 * The check is AST-based (`ts.createSourceFile`), not a text scan, per the
 * repository's `no-raw-text-source-scan` gate.
 *
 * SCOPE — deliberately narrower than "the gateway". It covers worktree
 * PROVISIONING and TEARDOWN only. Sibling main-thread code is still synchronous
 * and is knowingly out of scope for ISS-6132: `getCurrentBranchImpl` and
 * `readGitMetadata` (fast local reads whose sync signatures ripple through
 * `WorktreeProvider` and six test fakes), `findWorktreeForBranch` and
 * `resolveRepoFullName` in `git-helpers.ts`, and `executeGitOperations`, which
 * runs `git push` and `gh pr create` synchronously on the completion path and is
 * the larger remaining freeze. Adding them here would fail immediately; they
 * need converting first.
 *
 * LIMITATION: this walks each guarded function's own body and does not follow
 * the call graph, so routing work through an already-synchronous helper would
 * pass. It catches the likely regression (a fresh `execSync` typed into these
 * functions), not every possible one. That blind spot was real, not theoretical:
 * all three guarded functions resolved the git binary through the SYNCHRONOUS
 * `getResolvedGitPath`, whose cold-cache path runs `execFileSync($SHELL, -ilc)`,
 * and this guard stayed green throughout. They now await
 * `getResolvedGitPathAsync`; a callee-level regression still needs review, not
 * this test.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const desktopDir = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
const OPERATIONS_DIR = path.join(desktopDir, "src", "server", "operations");

/** `node:child_process` exports that block the calling thread. */
const SYNC_CHILD_PROCESS_CALLS = new Set([
  "execSync",
  "execFileSync",
  "spawnSync",
]);

/**
 * Functions that provision or tear down the loop worktree. Every one of them is
 * reached from the `symphony_loop` gateway operation, which backs EVERY
 * LoopCommand (PLAN/EXECUTE/REQUEST_CHANGES as well as GENERATE_PRD) — Generate
 * PRD is only the reported reproducer, not the sole affected path.
 */
const GUARDED_FUNCTIONS = [
  "createWorktreeCheckoutImpl",
  "removeWorktreeImpl",
  "branchExistsImpl",
] as const;

/** The called name for `foo()` and `mod.foo()`, or null for anything else. */
function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  return null;
}

/** Collect the names of blocking child-process calls made inside `node`. */
function collectSyncChildProcessCalls(node: ts.Node): string[] {
  const found: string[] = [];
  forEachNode(node, (current) => {
    if (!ts.isCallExpression(current)) {
      return;
    }
    const name = calleeName(current.expression);
    if (name !== null && SYNC_CHILD_PROCESS_CALLS.has(name)) {
      found.push(name);
    }
  });
  return found;
}

function findFunction(
  source: ts.SourceFile,
  name: string
): ts.FunctionDeclaration | null {
  let match: ts.FunctionDeclaration | null = null;
  forEachNode(source, (node) => {
    // First declaration wins, so a nested same-named function cannot displace
    // the top-level one this guard targets.
    if (
      match === null &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name
    ) {
      match = node;
    }
  });
  return match;
}

describe("ISS-6132 guard: no synchronous child processes on the worktree path", () => {
  test("the loop worktree git module makes no blocking child-process call", () => {
    const modulePath = path.join(OPERATIONS_DIR, "loop-worktree-git.ts");
    const found = collectSyncChildProcessCalls(parseTypeScriptFile(modulePath));

    assert.deepEqual(
      found,
      [],
      `loop-worktree-git.ts must stay off the Electron main thread; found ${found.join(", ")}. Use the async execFile wrapper (runGit) instead.`
    );
  });

  for (const functionName of GUARDED_FUNCTIONS) {
    test(`${functionName} makes no blocking child-process call`, () => {
      const source = parseTypeScriptFile(
        path.join(OPERATIONS_DIR, "symphony-loop.ts")
      );
      const declaration = findFunction(source, functionName);

      // `assert.ok` carries an `asserts value` signature, so it both reports the
      // rename and narrows away the null — no cast needed.
      assert.ok(
        declaration,
        `${functionName} was renamed or moved — re-point this guard at its new home rather than deleting it.`
      );

      const found = collectSyncChildProcessCalls(declaration);
      assert.deepEqual(
        found,
        [],
        `${functionName} runs on the Electron main thread via the desktop gateway; found ${found.join(", ")}. Await the async equivalent instead.`
      );
    });
  }
});
