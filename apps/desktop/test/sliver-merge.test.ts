/**
 * @file sliver-merge.test.ts
 * @description FEA-4010 (AA-12): unit tests for the sliver-merge post-pass —
 * sub-threshold span-edge slivers merge into an adjacent active segment
 * (backward / forward), same-run neighbors re-coalesce, and slivers that carry
 * meaning a merge would erase (a declared `review` window, a subagent-owned
 * slice) or that sit between idle spans are KEPT. Hand-built records exercise the
 * pass in isolation from the structural tiler.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivitySegmentRecord } from "../src/main/collectors/parsing/activity-segment-classifier.js";
import {
  ACTIVITY_PHASE,
  type ActivityPhase,
} from "../src/main/collectors/parsing/activity-taxonomy.js";
import {
  ACTIVITY_SLIVER_MS,
  mergeSlivers,
} from "../src/main/collectors/parsing/sliver-merge.js";

function rec(
  phase: ActivityPhase,
  startMs: number,
  endMs: number,
  overrides: Partial<ActivitySegmentRecord> = {}
): ActivitySegmentRecord {
  return {
    phase,
    startMs,
    endMs,
    confidence: 0.8,
    evidenceLayers: ["structural"],
    version: 6,
    ...overrides,
  };
}

const shape = (s: ActivitySegmentRecord): [ActivityPhase, number, number] => [
  s.phase,
  s.startMs,
  s.endMs,
];

test("a trailing sub-second sliver merges backward into its active neighbor", () => {
  const merged = mergeSlivers([
    rec(ACTIVITY_PHASE.Implement, 0, 5000),
    rec(ACTIVITY_PHASE.Plan, 5000, 5000 + ACTIVITY_SLIVER_MS - 1),
  ]);
  assert.deepEqual(
    merged.map(shape),
    [[ACTIVITY_PHASE.Implement, 0, 5000 + ACTIVITY_SLIVER_MS - 1]],
    "the plan sliver is absorbed by the preceding implement segment"
  );
});

test("a leading sliver with no active predecessor merges forward into the next", () => {
  const merged = mergeSlivers([
    rec(ACTIVITY_PHASE.Plan, 0, ACTIVITY_SLIVER_MS - 1), // pre-kickoff sliver
    rec(ACTIVITY_PHASE.Implement, ACTIVITY_SLIVER_MS - 1, 8000),
  ]);
  assert.deepEqual(
    merged.map(shape),
    [[ACTIVITY_PHASE.Implement, 0, 8000]],
    "the head sliver grafts its span onto the following implement segment"
  );
});

test("removing a sliver re-coalesces the same-phase neighbors it separated", () => {
  const merged = mergeSlivers([
    rec(ACTIVITY_PHASE.Implement, 0, 5000),
    rec(ACTIVITY_PHASE.Explore, 5000, 5500), // 500ms sliver between two implements
    rec(ACTIVITY_PHASE.Implement, 5500, 12_000),
  ]);
  assert.deepEqual(
    merged.map(shape),
    [[ACTIVITY_PHASE.Implement, 0, 12_000]],
    "backward-merge then coalesce yields one implement run"
  );
});

test("an active sliver isolated between idle spans is KEPT (never merged into idle)", () => {
  const merged = mergeSlivers([
    rec(ACTIVITY_PHASE.Idle, 0, 700_000, { confidence: 1, evidenceLayers: [] }),
    rec(ACTIVITY_PHASE.Implement, 700_000, 700_001), // lone 1ms resumed instant
    rec(ACTIVITY_PHASE.Idle, 700_001, 1_400_000, {
      confidence: 1,
      evidenceLayers: [],
    }),
  ]);
  assert.equal(merged.length, 3, "the isolated active instant survives");
  assert.equal(merged[1].phase, ACTIVITY_PHASE.Implement);
});

test("segments at or above the sliver threshold are left untouched", () => {
  const input = [
    rec(ACTIVITY_PHASE.Implement, 0, 5000),
    rec(ACTIVITY_PHASE.Explore, 5000, 5000 + ACTIVITY_SLIVER_MS),
  ];
  assert.deepEqual(mergeSlivers(input), input, "no merge at the threshold");
});

test("a subagent-owned sliver between differently-owned neighbors is KEPT (provenance preserved)", () => {
  // The sub-2s slice belongs to a subagent; both neighbors are main-agent. Absorbing
  // it would silently reassign delegated spend to the wrong owner, so it is kept.
  const merged = mergeSlivers([
    rec(ACTIVITY_PHASE.Implement, 0, 5000, { subagentId: null }),
    rec(ACTIVITY_PHASE.Explore, 5000, 5500, { subagentId: "sub-1" }),
    rec(ACTIVITY_PHASE.Implement, 5500, 12_000, { subagentId: null }),
  ]);
  assert.equal(merged.length, 3, "the subagent-owned sliver is not absorbed");
  assert.equal(merged[1].phase, ACTIVITY_PHASE.Explore);
  assert.equal(merged[1].subagentId, "sub-1");
});

test("a sub-2s declared review window is NOT absorbed away (review survives)", () => {
  // A review request landing <2s before a boundary mints a sub-threshold review
  // piece; erasing it would defeat the review detection AA-12 must preserve.
  const merged = mergeSlivers([
    rec(ACTIVITY_PHASE.Implement, 0, 5000),
    rec(ACTIVITY_PHASE.Review, 5000, 5500, {
      confidence: 0.9,
      evidenceLayers: ["declared", "structural"],
    }),
    rec(ACTIVITY_PHASE.Implement, 5500, 12_000),
  ]);
  assert.equal(merged.length, 3, "the declared review window is preserved");
  assert.equal(merged[1].phase, ACTIVITY_PHASE.Review);
});

test("a subagent-owned sliver between SAME-owner, different-phase spans is KEPT", () => {
  // One subagent does a brief Explore between two Implement stretches. Matching
  // (non-null) subagent IDs must NOT license absorption: AA-12 keeps delegated
  // slices whole, so the owned Explore sliver survives rather than being folded
  // into the same subagent's Implement span and losing its phase.
  const merged = mergeSlivers([
    rec(ACTIVITY_PHASE.Implement, 0, 5000, { subagentId: "sub-1" }),
    rec(ACTIVITY_PHASE.Explore, 5000, 5500, { subagentId: "sub-1" }),
    rec(ACTIVITY_PHASE.Implement, 5500, 12_000, { subagentId: "sub-1" }),
  ]);
  assert.equal(merged.length, 3, "the same-owner sliver is not absorbed");
  assert.equal(merged[1].phase, ACTIVITY_PHASE.Explore);
  assert.equal(merged[1].subagentId, "sub-1");
});

test("a same-owner, same-phase owned pair still re-coalesces (no fragmentation)", () => {
  // Rejecting owned slivers must not leave same-phase owned pieces fragmented: the
  // trailing provenance coalesce still merges a <2s owned tail into its same-phase,
  // same-owner predecessor.
  const merged = mergeSlivers([
    rec(ACTIVITY_PHASE.Implement, 0, 5000, { subagentId: "sub-1" }),
    rec(ACTIVITY_PHASE.Implement, 5000, 5500, { subagentId: "sub-1" }),
  ]);
  assert.deepEqual(
    merged.map(shape),
    [[ACTIVITY_PHASE.Implement, 0, 5500]],
    "same-owner same-phase pieces coalesce into one run"
  );
});

test("a sub-2s CARRIED window is NOT absorbed (AA-05 capped-confidence/empty-evidence survives)", () => {
  // phase-carry (AA-05) stamps an inherited window with empty evidence and a capped
  // 0.5 confidence. sliver-merge runs AFTER carry, so a <2s carried window sits
  // between its establishing span and more of the same phase. Absorbing it would let
  // the establishing window's first-hand `structural`/0.8 widen over a span AA-05
  // marked evidence-free — re-inflating the evidence-backed footprint. It is kept.
  const merged = mergeSlivers([
    rec(ACTIVITY_PHASE.Implement, 0, 5000, {
      confidence: 0.8,
      evidenceLayers: ["structural"],
    }),
    rec(ACTIVITY_PHASE.Implement, 5000, 5500, {
      confidence: 0.5,
      evidenceLayers: [], // carried: inherited phase, no first-hand evidence
    }),
    rec(ACTIVITY_PHASE.Implement, 5500, 12_000, {
      confidence: 0.8,
      evidenceLayers: ["structural"],
    }),
  ]);
  assert.equal(merged.length, 3, "the carried window is preserved");
  assert.equal(merged[1].confidence, 0.5);
  assert.deepEqual(merged[1].evidenceLayers, []);
});
