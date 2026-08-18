/**
 * @file phase-carry.test.ts
 * @description PRD-488 state-aware attribution: deterministic tests for the
 * stateful carry post-pass — leading-only `explore`, ambient inheritance of the
 * current phase, review-request → `review` (with mid-segment split), and phase
 * persistence across `idle`. Segments are hand-built `RelabelableSegment`s so the
 * pass is exercised in isolation from the structural tiler.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EvidenceLayer } from "../src/main/collectors/evidence/evidence-model.js";
import type { RelabelableSegment } from "../src/main/collectors/parsing/activity-segment-relabel.js";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";
import {
  applyStatefulPhaseCarry,
  CARRIED_CONFIDENCE,
  REVIEW_REQUEST_CONFIDENCE,
} from "../src/main/collectors/parsing/phase-carry.js";

type Seg = RelabelableSegment;
function seg(
  phase: string,
  startMs: number,
  endMs: number,
  confidence = 0.8,
  evidenceLayers: string[] = [EvidenceLayer.Structural]
): Seg {
  return { phase, startMs, endMs, confidence, evidenceLayers } as Seg;
}
const shape = (s: Seg): [string, number, number] => [
  s.phase,
  s.startMs,
  s.endMs,
];

test("a read window AFTER a strong phase inherits it as a CARRIED window (AA-05)", () => {
  const out = applyStatefulPhaseCarry(
    [
      seg(ACTIVITY_PHASE.Explore, 0, 10),
      seg(ACTIVITY_PHASE.Implement, 10, 20),
      seg(ACTIVITY_PHASE.Explore, 20, 30), // reads DURING implementing
    ],
    []
  );
  // Leading explore stays; the trailing read INHERITS implement — but AA-05 marks
  // it `carried` at a capped confidence rather than copying the establishing
  // window's fields, so it no longer coalesces into one implement segment.
  assert.deepEqual(out.map(shape), [
    [ACTIVITY_PHASE.Explore, 0, 10],
    [ACTIVITY_PHASE.Implement, 10, 20],
    [ACTIVITY_PHASE.Implement, 20, 30],
  ]);
  const carried = out[2];
  assert.equal(carried.confidence, CARRIED_CONFIDENCE);
  assert.deepEqual(carried.evidenceLayers, []);
  // The establishing window keeps its own first-hand structural provenance.
  assert.deepEqual(out[1].evidenceLayers, [EvidenceLayer.Structural]);
});

test("a pure-read session with no strong phase stays leading explore", () => {
  const out = applyStatefulPhaseCarry(
    [seg(ACTIVITY_PHASE.Explore, 0, 10), seg(ACTIVITY_PHASE.Other, 10, 20)],
    []
  );
  // Nothing transitioned out of the leading orientation, so both stay as scored.
  assert.deepEqual(out.map(shape), [
    [ACTIVITY_PHASE.Explore, 0, 10],
    [ACTIVITY_PHASE.Other, 10, 20],
  ]);
});

test("a review request at session start establishes review; later reads carry it (AA-05)", () => {
  const out = applyStatefulPhaseCarry(
    [seg(ACTIVITY_PHASE.Explore, 0, 20), seg(ACTIVITY_PHASE.Explore, 20, 40)],
    [0]
  );
  assert.deepEqual(out.map(shape), [
    [ACTIVITY_PHASE.Review, 0, 20],
    [ACTIVITY_PHASE.Review, 20, 40],
  ]);
  // The window covering the request carries first-hand declared provenance + the
  // review-request confidence; the continued read inherits review as `carried`.
  assert.equal(out[0].confidence, REVIEW_REQUEST_CONFIDENCE);
  assert.deepEqual(out[0].evidenceLayers, [
    EvidenceLayer.Declared,
    EvidenceLayer.Structural,
  ]);
  assert.equal(out[1].confidence, CARRIED_CONFIDENCE);
  assert.deepEqual(out[1].evidenceLayers, []);
});

test("a review request mid-segment splits it: pre stays leading, post becomes review", () => {
  const out = applyStatefulPhaseCarry(
    [seg(ACTIVITY_PHASE.Explore, 0, 30)],
    [10]
  );
  assert.deepEqual(out.map(shape), [
    [ACTIVITY_PHASE.Explore, 0, 10],
    [ACTIVITY_PHASE.Review, 10, 30],
  ]);
});

test("an idle gap RESETS the carried phase — resumed work re-establishes from its own evidence (AA-05)", () => {
  const out = applyStatefulPhaseCarry(
    [
      seg(ACTIVITY_PHASE.Implement, 0, 10),
      seg(ACTIVITY_PHASE.Idle, 10, 20, 1, []),
      seg(ACTIVITY_PHASE.Explore, 20, 30), // reads after resuming
    ],
    []
  );
  // BEFORE AA-05 the pre-idle `implement` carried across the gap and the resumed
  // read was stamped `implement` at the establishing confidence — the unbounded
  // stale-phase inheritance the audit flagged. Now the idle gap resets the state,
  // so the resumed read re-establishes from its OWN evidence (leading `explore`,
  // scored, not inherited).
  assert.deepEqual(out.map(shape), [
    [ACTIVITY_PHASE.Implement, 0, 10],
    [ACTIVITY_PHASE.Idle, 10, 20],
    [ACTIVITY_PHASE.Explore, 20, 30],
  ]);
  // The resumed window keeps its own first-hand evidence — not empty/carried.
  assert.deepEqual(out[2].evidenceLayers, [EvidenceLayer.Structural]);
});

test("a review request inside an idle gap snaps forward to the post-break active segment", () => {
  // Idle boundaries come from TURN timestamps; a review request (a human/slash
  // instant, not a turn) can land inside a ≥10-min idle gap. It must still establish
  // `review` on the post-break work — not be dropped, leaving the reads to inherit
  // the pre-break phase (`implement`). Regression for the silently-dropped-request bug.
  const out = applyStatefulPhaseCarry(
    [
      seg(ACTIVITY_PHASE.Implement, 0, 10),
      seg(ACTIVITY_PHASE.Idle, 10, 20, 1, []),
      seg(ACTIVITY_PHASE.Explore, 20, 30), // reads after the break
    ],
    [15] // review requested mid-idle-gap
  );
  assert.deepEqual(out.map(shape), [
    [ACTIVITY_PHASE.Implement, 0, 10],
    [ACTIVITY_PHASE.Idle, 10, 20],
    [ACTIVITY_PHASE.Review, 20, 30],
  ]);
  assert.equal(
    out.find((s) => s.phase === ACTIVITY_PHASE.Review)?.confidence,
    REVIEW_REQUEST_CONFIDENCE
  );
});

test("a prior rework relabel is a strong phase that carries forward (AA-05: as a carried window)", () => {
  const out = applyStatefulPhaseCarry(
    [
      seg(ACTIVITY_PHASE.Rework, 0, 10, 0.9, [
        EvidenceLayer.Declared,
        EvidenceLayer.Structural,
      ]),
      seg(ACTIVITY_PHASE.Explore, 10, 20),
    ],
    []
  );
  // Rework carries forward onto the following read, but as a distinct `carried`
  // window (capped confidence, carried provenance) — not merged into the
  // establishing rework span at its 0.9 declared confidence.
  assert.deepEqual(out.map(shape), [
    [ACTIVITY_PHASE.Rework, 0, 10],
    [ACTIVITY_PHASE.Rework, 10, 20],
  ]);
  assert.equal(out[0].confidence, 0.9);
  assert.equal(out[1].confidence, CARRIED_CONFIDENCE);
  assert.deepEqual(out[1].evidenceLayers, []);
});

test("AA-05: a carried window is never MORE confident than the window that set the phase", () => {
  // Establishing confidence below the carry cap: the carried window inherits the
  // LOWER of the two, so carry can only ever reduce confidence, never inflate it.
  const out = applyStatefulPhaseCarry(
    [
      seg(ACTIVITY_PHASE.Implement, 0, 10, 0.3, [EvidenceLayer.Structural]),
      seg(ACTIVITY_PHASE.Explore, 10, 20),
    ],
    []
  );
  assert.equal(out[1].phase, ACTIVITY_PHASE.Implement);
  assert.equal(out[1].confidence, 0.3);
  assert.deepEqual(out[1].evidenceLayers, []);
});

test("AA-05: after an idle reset a NEW strong phase re-establishes (not the pre-idle one)", () => {
  const out = applyStatefulPhaseCarry(
    [
      seg(ACTIVITY_PHASE.Implement, 0, 10),
      seg(ACTIVITY_PHASE.Idle, 10, 20, 1, []),
      seg(ACTIVITY_PHASE.Plan, 20, 30, 0.8, [EvidenceLayer.Declared]),
      seg(ACTIVITY_PHASE.Explore, 30, 40), // reads after the new plan phase
    ],
    []
  );
  // The reads AFTER the gap inherit the RESUMED phase (`plan`), not the pre-idle
  // `implement` — the idle reset scoped the earlier state to before the gap.
  assert.deepEqual(out.map(shape), [
    [ACTIVITY_PHASE.Implement, 0, 10],
    [ACTIVITY_PHASE.Idle, 10, 20],
    [ACTIVITY_PHASE.Plan, 20, 30],
    [ACTIVITY_PHASE.Plan, 30, 40],
  ]);
  assert.deepEqual(out[3].evidenceLayers, []);
});
