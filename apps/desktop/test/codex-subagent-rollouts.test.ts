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
  effectiveParentId,
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

// ── FEA-2928: fork/resume linkage tests ───────────────────────────────────

test("effectiveParentId returns parentThreadId when set", () => {
  const l = linkage("child", "parent");
  assert.equal(effectiveParentId(l), "parent");
});

test("effectiveParentId returns forkedFromId when parentThreadId is null", () => {
  const l = linkage("fork", null, 0, "/codex/fork.jsonl", "origin");
  assert.equal(effectiveParentId(l), "origin");
});

test("effectiveParentId returns parentThreadId when both are set", () => {
  const l = linkage("child", "parent", 1, "/codex/child.jsonl", "origin");
  assert.equal(effectiveParentId(l), "parent");
});

test("effectiveParentId returns null when neither is set", () => {
  const l = linkage("root", null);
  assert.equal(effectiveParentId(l), null);
});

test("walkCodexRootLinkage follows fork chain (A → fork B → fork C)", () => {
  const a = linkage("a", null, 0, "/codex/a.jsonl");
  const b = linkage("b", null, null, "/codex/b.jsonl", "a");
  const c = linkage("c", null, null, "/codex/c.jsonl", "b");
  const byId = new Map<string, CodexRolloutLinkage>([
    ["a", a],
    ["b", b],
    ["c", c],
  ]);

  assert.equal(walkCodexRootLinkage(c, byId).rolloutId, "a");
  assert.equal(walkCodexRootLinkage(b, byId).rolloutId, "a");
  assert.equal(walkCodexRootLinkage(a, byId).rolloutId, "a");
});

test("walkCodexRootLinkage follows mixed chain (A → subagent B → fork C)", () => {
  const a = linkage("a", null, 0);
  const b = linkage("b", "a", 1);
  const c = linkage("c", null, null, "/codex/c.jsonl", "b");
  const byId = new Map<string, CodexRolloutLinkage>([
    ["a", a],
    ["b", b],
    ["c", c],
  ]);

  assert.equal(walkCodexRootLinkage(c, byId).rolloutId, "a");
});

test("walkCodexRootLinkage terminates on fork cycle (A forks from B, B forks from A)", () => {
  const a = linkage("a", null, null, "/codex/a.jsonl", "b");
  const b = linkage("b", null, null, "/codex/b.jsonl", "a");
  const byId = new Map<string, CodexRolloutLinkage>([
    ["a", a],
    ["b", b],
  ]);

  const root = walkCodexRootLinkage(a, byId);
  assert.equal(root.rolloutId, "b");
});

test("walkCodexRootLinkage treats orphan fork as root", () => {
  const fork = linkage("fork", null, null, "/codex/fork.jsonl", "ghost");
  const byId = new Map<string, CodexRolloutLinkage>([["fork", fork]]);

  assert.equal(walkCodexRootLinkage(fork, byId).rolloutId, "fork");
});

test("buildCodexChildrenById indexes fork children", () => {
  const root = linkage("root", null, 0);
  const fork = linkage("fork", null, null, "/codex/fork.jsonl", "root");
  const byId = new Map<string, CodexRolloutLinkage>([
    ["root", root],
    ["fork", fork],
  ]);

  const childrenById = buildCodexChildrenById(byId);
  const rootChildren = childrenById.get("root") ?? [];
  assert.equal(rootChildren.length, 1);
  assert.equal(rootChildren[0]?.rolloutId, "fork");
});

test("findCodexDescendants returns fork rollouts as descendants", () => {
  const root = linkage("root", null, 0);
  const fork = linkage("fork", null, null, "/codex/fork.jsonl", "root");
  const byId = new Map<string, CodexRolloutLinkage>([
    ["root", root],
    ["fork", fork],
  ]);

  const descendants = findCodexDescendants(
    "",
    [],
    byId,
    buildCodexChildrenById(byId),
    root
  );
  assert.equal(descendants.length, 1);
  assert.equal(descendants[0]?.rolloutId, "fork");
});

test("findCodexParentSource returns parent for forked rollout", () => {
  const root = linkage("root", null, 0, "/codex/root.jsonl");
  const fork = linkage("fork", null, null, "/codex/fork.jsonl", "root");
  const byId = new Map<string, CodexRolloutLinkage>([
    ["root", root],
    ["fork", fork],
  ]);

  assert.equal(
    findCodexParentSource("/codex/fork.jsonl", [], byId, fork),
    "/codex/root.jsonl"
  );
});

test("findCodexParentSource returns null for orphan fork", () => {
  const fork = linkage("fork", null, null, "/codex/fork.jsonl", "ghost");
  const byId = new Map<string, CodexRolloutLinkage>([["fork", fork]]);

  assert.equal(
    findCodexParentSource("/codex/fork.jsonl", [], byId, fork),
    null
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
