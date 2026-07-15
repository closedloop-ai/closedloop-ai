/**
 * @file codex-subagent-rollouts.test.ts
 * @description FEA-2849 — cycle-guard and dedup coverage for the Codex rollout
 * graph helpers. Existing collector/discovery tests only walk acyclic
 * root→child→grandchild chains, so the cycle guards in `walkCodexRootLinkage`
 * and `findCodexDescendants`, the `mapCodexRolloutsById` dedup, and the
 * orphan-parent return of `findCodexParentSource` were entirely unasserted. A
 * malformed/adversarial rollout that claims an ancestor as its parent (a→b→a)
 * relies on those `seen`-set branches to avoid an infinite loop; these tests
 * prove they terminate.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { CodexRolloutLinkage } from "../src/main/collectors/codex/codex-subagent-rollouts.js";
import {
  buildCodexChildrenById,
  findCodexDescendants,
  findCodexParentSource,
  mapCodexRolloutsById,
  walkCodexRootLinkage,
} from "../src/main/collectors/codex/codex-subagent-rollouts.js";
import {
  cleanupTempDirs,
  codexLinkage as linkage,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

test("walkCodexRootLinkage terminates on a cyclic parent chain (a->b->a)", () => {
  const a = linkage("a", "b");
  const b = linkage("b", "a");
  const byId = new Map<string, CodexRolloutLinkage>([
    ["a", a],
    ["b", b],
  ]);

  // Without the `seen.has(parent.rolloutId)` break this walk would loop forever:
  // a claims b as parent, b claims a. The walk visits b, then sees a already in
  // `seen` and stops there rather than re-entering the cycle.
  const root = walkCodexRootLinkage(a, byId);

  assert.equal(root.rolloutId, "b");
});

test("walkCodexRootLinkage stops when the claimed parent is missing (orphan)", () => {
  const child = linkage("child", "ghost");

  const root = walkCodexRootLinkage(
    child,
    new Map<string, CodexRolloutLinkage>([["child", child]])
  );

  assert.equal(root.rolloutId, "child");
});

test("findCodexDescendants terminates on a cyclic descendant graph (a->b->a)", () => {
  const a = linkage("a", "b");
  const b = linkage("b", "a");
  const byId = new Map<string, CodexRolloutLinkage>([
    ["a", a],
    ["b", b],
  ]);

  // From root `a`: visit child `b`, whose only child is `a` — already in `seen`,
  // so the `seen.has(child.rolloutId)` skip prevents an unbounded BFS.
  const descendants = findCodexDescendants(
    "",
    [],
    byId,
    buildCodexChildrenById(byId),
    a
  );

  assert.deepEqual(
    descendants.map((d) => d.rolloutId),
    ["b"]
  );
});

test("findCodexDescendants returns descendants sorted by ascending depth", () => {
  const root = linkage("root", null, 0);
  // Insertion order deliberately differs from depth order to prove the sort.
  const deep = linkage("deep", "root", 3);
  const shallow = linkage("shallow", "root", 1);
  const mid = linkage("mid", "root", 2);
  const byId = new Map<string, CodexRolloutLinkage>([
    ["root", root],
    ["deep", deep],
    ["shallow", shallow],
    ["mid", mid],
  ]);

  const descendants = findCodexDescendants(
    "",
    [],
    byId,
    buildCodexChildrenById(byId),
    root
  );

  assert.deepEqual(
    descendants.map((d) => d.rolloutId),
    ["shallow", "mid", "deep"]
  );
});

test("findCodexParentSource returns null when the claimed parent is absent", () => {
  const child = linkage("child", "ghost", 1, "/codex/child.jsonl");
  const byId = new Map<string, CodexRolloutLinkage>([["child", child]]);

  const parent = findCodexParentSource("/codex/child.jsonl", [], byId, child);

  assert.equal(parent, null);
});

test("findCodexParentSource resolves the parent source path when present", () => {
  const parentLinkage = linkage("parent", null, 0, "/codex/parent.jsonl");
  const child = linkage("child", "parent", 1, "/codex/child.jsonl");
  const byId = new Map<string, CodexRolloutLinkage>([
    ["parent", parentLinkage],
    ["child", child],
  ]);

  assert.equal(
    findCodexParentSource("/codex/child.jsonl", [], byId, child),
    "/codex/parent.jsonl"
  );
});

test("mapCodexRolloutsById keeps the first source for a duplicate rolloutId", () => {
  const dir = makeTempDir("codex-rollout-dedup-");
  const dupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const firstPath = path.join(dir, `rollout-first-${dupId}.jsonl`);
  const secondPath = path.join(dir, `rollout-second-${dupId}.jsonl`);
  const meta = (id: string) =>
    `${JSON.stringify({
      timestamp: "2026-06-24T10:00:00.000Z",
      type: "session_meta",
      payload: { id, source: "exec" },
    })}\n`;
  writeFileSync(firstPath, meta(dupId), "utf8");
  writeFileSync(secondPath, meta(dupId), "utf8");

  const byId = mapCodexRolloutsById([firstPath, secondPath]);

  assert.equal(byId.size, 1);
  assert.equal(byId.get(dupId)?.sourcePath, firstPath);
});
