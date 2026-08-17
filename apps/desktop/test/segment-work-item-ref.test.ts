/**
 * @file segment-work-item-ref.test.ts
 * @description FEA-2272 (PLN-1197) unit tests for the PURE work-item resolver.
 * Covers the strict no-op on empty links, session-level slug fan-out, primary
 * and deterministic tie-break precedence, time-scoped refinement, the PR/branch
 * fallback gate (both states), commit exclusion, and order-independence.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";
import {
  resolveSegmentWorkItemRefs,
  type SegmentSpan,
  type WorkItemCandidate,
} from "../src/main/database/segment-work-item-ref.js";

function seg(
  id: string,
  startMs: number,
  endMs: number,
  phase: string = ACTIVITY_PHASE.Implement
): SegmentSpan {
  return { id, startMs, endMs, phase };
}

function slug(
  value: string,
  opts: { isPrimary?: boolean; occurredAtMs?: number } = {}
): WorkItemCandidate {
  return {
    slug: value,
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    relation: ArtifactRefRelation.Workspace,
    isPrimary: opts.isPrimary ?? false,
    occurredAtMs: opts.occurredAtMs ?? null,
    prNumber: null,
    branchName: null,
    repoFullName: null,
  };
}

function pr(repoFullName: string, prNumber: number): WorkItemCandidate {
  return {
    slug: null,
    kind: ArtifactRefTargetKind.PullRequest,
    relation: ArtifactRefRelation.Created,
    isPrimary: false,
    occurredAtMs: null,
    prNumber,
    branchName: null,
    repoFullName,
  };
}

function branch(branchName: string): WorkItemCandidate {
  return {
    slug: null,
    kind: ArtifactRefTargetKind.Branch,
    relation: ArtifactRefRelation.Workspace,
    isPrimary: false,
    occurredAtMs: null,
    prNumber: null,
    branchName,
    repoFullName: null,
  };
}

function commit(): WorkItemCandidate {
  return {
    slug: null,
    kind: ArtifactRefTargetKind.Commit,
    relation: ArtifactRefRelation.Created,
    isPrimary: false,
    occurredAtMs: null,
    prNumber: null,
    branchName: null,
    repoFullName: null,
  };
}

const THREE = [seg("A", 0, 100), seg("B", 100, 200), seg("C", 200, 300)];

function values(map: Map<string, string | null>): (string | null)[] {
  return THREE.map((s) => map.get(s.id) ?? null);
}

test("empty candidates → every segment is null (strict no-op)", () => {
  const map = resolveSegmentWorkItemRefs(THREE, [], []);
  assert.deepEqual(values(map), [null, null, null]);
});

test("session-scoped slug fans out to every segment", () => {
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-1", { isPrimary: true })],
    []
  );
  assert.deepEqual(values(map), ["FEA-1", "FEA-1", "FEA-1"]);
});

test("the primary slug wins over a non-primary one for all segments", () => {
  // FEA-9 is primary but sorts AFTER FEA-1 by code point, so a correct result
  // proves primary beat the tie-break, not that it merely sorted first.
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-1", { isPrimary: false }), slug("FEA-9", { isPrimary: true })],
    []
  );
  assert.deepEqual(values(map), ["FEA-9", "FEA-9", "FEA-9"]);
});

test("with no primary, the code-point-smallest slug wins deterministically", () => {
  const forward = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-9"), slug("FEA-1")],
    []
  );
  const reversed = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-1"), slug("FEA-9")],
    []
  );
  assert.deepEqual(values(forward), ["FEA-1", "FEA-1", "FEA-1"]);
  assert.deepEqual(
    values(reversed),
    values(forward),
    "input order does not change the result"
  );
});

test("a time-scoped slug refines only the segment whose span contains it", () => {
  // Session primary is FEA-1; a second slug carries a per-occurrence timestamp
  // inside segment B, so only B refines to it.
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-1", { isPrimary: true }), slug("FEA-2", { occurredAtMs: 150 })],
    []
  );
  assert.deepEqual(values(map), ["FEA-1", "FEA-2", "FEA-1"]);
});

test("PR/branch fallback gate OFF: a slug-less session stays all-null", () => {
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [pr("owner/repo", 5), branch("feature/x")],
    [],
    { includePrBranchFallback: false }
  );
  assert.deepEqual(values(map), [null, null, null]);
});

test("PR/branch fallback gate ON: PR labels a slug-less session, PR beats branch", () => {
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [branch("feature/x"), pr("owner/repo", 5)],
    [],
    { includePrBranchFallback: true }
  );
  assert.deepEqual(
    values(map),
    ["owner/repo#5", "owner/repo#5", "owner/repo#5"],
    "PR outranks branch"
  );
});

test("a slug always outranks a PR even with the gate ON", () => {
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [pr("owner/repo", 5), slug("FEA-1")],
    [],
    { includePrBranchFallback: true }
  );
  assert.deepEqual(values(map), ["FEA-1", "FEA-1", "FEA-1"]);
});

test("a commit link never labels a segment (excluded even alongside a slug)", () => {
  const commitOnly = resolveSegmentWorkItemRefs(THREE, [commit()], [], {
    includePrBranchFallback: true,
  });
  assert.deepEqual(values(commitOnly), [null, null, null]);

  const withSlug = resolveSegmentWorkItemRefs(
    THREE,
    [commit(), slug("FEA-1")],
    []
  );
  assert.deepEqual(values(withSlug), ["FEA-1", "FEA-1", "FEA-1"]);
});

test("only FEA/PLN/PRD slugs are work items; PRO-*/SES-* are never stamped", () => {
  const projectOnly = resolveSegmentWorkItemRefs(
    THREE,
    [slug("PRO-7", { isPrimary: true }), slug("SES-42")],
    []
  );
  assert.deepEqual(
    values(projectOnly),
    [null, null, null],
    "a project/session slug is not a work item"
  );

  // A PRO-* alongside a real FEA-* must never displace it, even when marked
  // primary (a non-work-item slug is filtered out before precedence applies).
  const mixed = resolveSegmentWorkItemRefs(
    THREE,
    [slug("PRO-7", { isPrimary: true }), slug("PLN-3")],
    []
  );
  assert.deepEqual(values(mixed), ["PLN-3", "PLN-3", "PLN-3"]);
});

test("a work-item slug wider than five digits is still stamped (no width cap)", () => {
  // The family prefix is the gate, not the number's width — the linker decides
  // what is a valid slug. A capped pattern here would silently drop a linked
  // session the day slug numbering grows past the cap.
  const map = resolveSegmentWorkItemRefs(THREE, [slug("FEA-123456")], []);
  assert.deepEqual(values(map), ["FEA-123456", "FEA-123456", "FEA-123456"]);
});

test("a time-scoped candidate refines only its own segment, never the whole session", () => {
  // The ONLY candidate is scoped to segment B. Segments A and C have no unscoped
  // candidate to fall back to, so they stay null — the scoped ref must not leak
  // to the session level.
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-1", { occurredAtMs: 150 })],
    []
  );
  assert.deepEqual(values(map), [null, "FEA-1", null]);
});

test("shuffled candidates yield a byte-identical map (determinism)", () => {
  const candidates = [
    slug("FEA-5"),
    slug("FEA-1", { isPrimary: true }),
    slug("FEA-3", { occurredAtMs: 150 }),
    slug("FEA-2"),
  ];
  const forward = resolveSegmentWorkItemRefs(THREE, candidates, []);
  const reversed = resolveSegmentWorkItemRefs(
    THREE,
    [...candidates].reverse(),
    []
  );
  assert.deepEqual(values(forward), values(reversed));
  // B refines to the time-scoped FEA-3; A and C take the primary FEA-1.
  assert.deepEqual(values(forward), ["FEA-1", "FEA-3", "FEA-1"]);
});

// --- FEA-4010 (AA-10): per-segment resolution from the mention stream ---------

/** A work-item mention at `occurredAtMs`. */
function mention(slugValue: string, occurredAtMs: number) {
  return { slug: slugValue, occurredAtMs };
}

test("AA-10: a session working TWO items splits per segment, not one winner", () => {
  // The shape the audit found on 3d624f34: a first-item stretch, then a second.
  // No single-value-per-session rule can express this, which is why the old
  // code-point tie-break stamped one slug across both halves.
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-1224"), slug("FEA-1189")],
    [mention("FEA-1224", 10), mention("FEA-1189", 210)]
  );
  assert.deepEqual(values(map), ["FEA-1224", "FEA-1224", "FEA-1189"]);
});

test("AA-10: mention count decides, so one incidental mention cannot win", () => {
  // FEA-1189 sorts FIRST and would have won the old code-point tie-break despite
  // being mentioned once against FEA-1224's three times.
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-1224"), slug("FEA-1189")],
    [
      mention("FEA-1189", 10),
      mention("FEA-1224", 20),
      mention("FEA-1224", 30),
      mention("FEA-1224", 40),
    ]
  );
  assert.equal(map.get("A"), "FEA-1224");
});

test("AA-10: the ref carries between mentions — work continues unmentioned", () => {
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-1224")],
    [mention("FEA-1224", 10)]
  );
  assert.deepEqual(values(map), ["FEA-1224", "FEA-1224", "FEA-1224"]);
});

test("AA-10: the run before the first mention is filled from it", () => {
  // Work on an item routinely starts before the item is NAMED — the ticket often
  // first appears at commit or PR time. Leaving that opening run null discarded
  // 32 of 35 correctly-labelled segments on a measured session. Backward-filling
  // one known item cannot smear a second item's stretch: the next mention takes
  // over from its own segment onward.
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-1224"), slug("FEA-1189")],
    [mention("FEA-1224", 150), mention("FEA-1189", 250)]
  );
  assert.deepEqual(values(map), ["FEA-1224", "FEA-1224", "FEA-1189"]);
});

test("AA-10: an idle segment never carries a work item, but carry survives it", () => {
  // Idle is not a gap in the label, it is the absence of work — the audit called
  // out "every segment (including idle) carries work_item_ref". The segment AFTER
  // the idle still continues the same item.
  const spans = [
    seg("A", 0, 100),
    seg("B", 100, 200, ACTIVITY_PHASE.Idle),
    seg("C", 200, 300),
  ];
  const map = resolveSegmentWorkItemRefs(
    spans,
    [slug("FEA-1224")],
    [mention("FEA-1224", 10)]
  );
  assert.deepEqual(
    spans.map((s) => map.get(s.id) ?? null),
    ["FEA-1224", null, "FEA-1224"]
  );
});

test("AA-10: a mention of an UNLINKED slug never labels anything", () => {
  // The linker stays the authority on WHAT a session is linked to; occurrences
  // only say WHEN. A slug seen in prose but never persisted as a link is not a
  // work item for this session.
  const map = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-1224")],
    [mention("PLN-721", 10), mention("FEA-1224", 210)]
  );
  // PLN-721 is mentioned FIRST and would otherwise seed the backward fill; only
  // the linked FEA-1224 may label anything.
  assert.ok(
    !values(map).includes("PLN-721"),
    "an unlinked slug must never label a segment"
  );
  assert.deepEqual(values(map), ["FEA-1224", "FEA-1224", "FEA-1224"]);
});

test("AA-10: with NO mentions the session-level fan-out is preserved", () => {
  // A session identified only by cwd / branch / launch metadata links without
  // ever being mentioned. That is a genuinely session-scoped label, not a smear.
  const map = resolveSegmentWorkItemRefs(THREE, [slug("FEA-1224")], []);
  assert.deepEqual(values(map), ["FEA-1224", "FEA-1224", "FEA-1224"]);
});

test("AA-10: the session-level fan-out still skips idle segments", () => {
  // The fan-out path is reached when a session links via cwd / branch / launch
  // metadata and never mentions the slug. Idle claims nothing there for the same
  // reason it claims nothing on the occurrence path — the rule is about what a
  // segment can honestly assert, not about how its label was derived.
  const map = resolveSegmentWorkItemRefs(
    [
      seg("A", 0, 100),
      seg("B", 100, 200, ACTIVITY_PHASE.Idle),
      seg("C", 200, 300),
    ],
    [slug("FEA-1224")],
    []
  );
  assert.deepEqual(values(map), ["FEA-1224", null, "FEA-1224"]);
});

test("AA-10: the backward-fill seed is the EARLIEST mention, not the array-first one", () => {
  // Every production caller passes a time-sorted stream, so this guards the
  // contract rather than a live path: the opening run precedes both mentions, and
  // the stream is handed over later-first. Seeding by array position would label
  // that opening run with the LATER ticket.
  const segments = [
    seg("A", 0, 100),
    seg("B", 100, 200),
    seg("C", 200, 300),
    seg("D", 300, 400),
  ];
  const candidates = [slug("FEA-1224"), slug("FEA-1189")];
  const unsorted = [mention("FEA-1189", 350), mention("FEA-1224", 250)];
  // `values` reads the shared THREE fixture, so read this 4-segment map directly.
  const refs = (map: Map<string, string | null>) =>
    segments.map((s) => map.get(s.id) ?? null);
  const map = resolveSegmentWorkItemRefs(segments, candidates, unsorted);
  assert.deepEqual(refs(map), ["FEA-1224", "FEA-1224", "FEA-1224", "FEA-1189"]);
  // …and the sorted stream every caller actually supplies agrees.
  assert.deepEqual(
    refs(
      resolveSegmentWorkItemRefs(segments, candidates, [...unsorted].reverse())
    ),
    refs(map)
  );
});

test("AA-10: resolution is order-independent (determinism)", () => {
  const occurrences = [mention("FEA-1224", 10), mention("FEA-1189", 210)];
  const forward = resolveSegmentWorkItemRefs(
    THREE,
    [slug("FEA-1224"), slug("FEA-1189")],
    occurrences
  );
  const reversed = resolveSegmentWorkItemRefs(
    [...THREE].reverse(),
    [slug("FEA-1189"), slug("FEA-1224")],
    [...occurrences].reverse()
  );
  assert.deepEqual(values(forward), values(reversed));
});
