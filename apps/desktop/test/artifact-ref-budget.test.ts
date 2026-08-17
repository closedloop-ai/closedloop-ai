/**
 * @file artifact-ref-budget.test.ts
 * @description ISS-4448+4449 — proves the desktop producer's non-commit
 * `artifactRefs` budget no longer silently drops document (`closedloop_artifact`)
 * refs on a PR-heavy session.
 *
 * The regression this guards: the old code sliced the combined non-commit array
 * with a single `slice(0, 100)`. With PR refs ordered ahead of document refs
 * (e.g. 88 PR refs then 23 document refs = 111 non-commit refs), the 100-slot
 * slice kept all 88 PRs plus only the first 12 document refs and dropped the
 * remaining 11 real document links before they ever reached the cloud — silent
 * data loss that `linkedArtifactsTotal` (a post-persist count) then reported as
 * complete. `boundNonCommitArtifactRefs` gives document refs a guaranteed floor
 * so they survive.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
  MIN_SYNCED_DOCUMENT_REFS_PRODUCER,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { boundNonCommitArtifactRefs } from "../src/main/database/artifact-ref-budget.js";

function makePrRef(prNumber: number): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: "acme/repo",
    prNumber,
    method: ArtifactRefMethod.PrUrlInToolUse,
    relation: ArtifactRefRelation.Created,
  };
}

function makeDocRef(index: number): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    slug: `FEA-${index}`,
    isPrimary: false,
    method: ArtifactRefMethod.SlugInMessage,
    relation: ArtifactRefRelation.Created,
  };
}

function documentSlugs(refs: readonly SyncedArtifactRef[]): string[] {
  return refs
    .filter((ref) => ref.kind === ArtifactRefTargetKind.ClosedloopArtifact)
    .map((ref) =>
      ref.kind === ArtifactRefTargetKind.ClosedloopArtifact ? ref.slug : ""
    );
}

describe("boundNonCommitArtifactRefs (ISS-4448+4449 producer document floor)", () => {
  test("a small non-commit set passes through unchanged", () => {
    const refs = [makePrRef(1), makeDocRef(0), makeDocRef(1)];
    const bounded = boundNonCommitArtifactRefs(refs);
    assert.deepEqual(
      bounded,
      refs,
      "under the cap: no slicing, order preserved"
    );
  });

  test("a PR-heavy over-cap session KEEPS its document refs (the wongk data-loss)", () => {
    // 88 PR refs ordered ahead of 23 document refs — wongk's exact scenario.
    // Old behavior: slice(0,100) kept 88 PRs + only 12 doc refs, dropping 11.
    const prCount = 88;
    const docCount = 23;
    const prRefs = Array.from({ length: prCount }, (_, i) => makePrRef(i + 1));
    const docRefs = Array.from({ length: docCount }, (_, i) => makeDocRef(i));
    const refs = [...prRefs, ...docRefs];
    assert.ok(
      refs.length > MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
      "fixture must exceed the producer cap so the slice path is exercised"
    );

    const bounded = boundNonCommitArtifactRefs(refs);

    assert.equal(
      bounded.length,
      MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
      "total stays at the deploy-order-safe producer cap"
    );
    // The whole point: all 23 document refs survive — none silently dropped —
    // because 23 <= the guaranteed document floor is NOT even needed here; the
    // floor guarantees them and the remaining budget goes to PRs.
    const keptDocs = documentSlugs(bounded);
    assert.equal(
      keptDocs.length,
      docCount,
      "every document ref survives the over-cap slice"
    );
    for (let i = 0; i < docCount; i++) {
      assert.ok(
        keptDocs.includes(`FEA-${i}`),
        `document ref FEA-${i} must not be silently dropped`
      );
    }
    // PRs fill the remaining budget (100 - 23 = 77 of the 88), earliest first.
    const keptPrNums = new Set(
      bounded
        .filter((ref) => ref.kind === ArtifactRefTargetKind.PullRequest)
        .map((ref) =>
          ref.kind === ArtifactRefTargetKind.PullRequest ? ref.prNumber : -1
        )
    );
    assert.equal(
      keptPrNums.size,
      MAX_SYNCED_ARTIFACT_REFS_PRODUCER - docCount,
      "PRs fill exactly the budget left after documents are guaranteed"
    );
    assert.ok(keptPrNums.has(1), "earliest PR kept");
  });

  test("document refs above the floor are still capped when PRs also compete", () => {
    // Far more document refs than the floor AND more PRs than the leftover —
    // documents are guaranteed the floor, PRs take the rest, and the total is
    // still the producer cap with no over-emit.
    const docRefs = Array.from({ length: 200 }, (_, i) => makeDocRef(i));
    const prRefs = Array.from({ length: 200 }, (_, i) => makePrRef(i + 1));
    const bounded = boundNonCommitArtifactRefs([...prRefs, ...docRefs]);

    assert.equal(
      bounded.length,
      MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
      "never emits more than the producer cap"
    );
    const keptDocs = documentSlugs(bounded);
    assert.ok(
      keptDocs.length >= MIN_SYNCED_DOCUMENT_REFS_PRODUCER,
      `documents get at least the guaranteed floor (${MIN_SYNCED_DOCUMENT_REFS_PRODUCER})`
    );
    // Earliest document refs are the ones kept (stable oldest-first subsequence).
    assert.ok(keptDocs.includes("FEA-0"), "earliest document ref kept");
  });

  test("a document-light session hands spare reserved slots back to other kinds", () => {
    // Only 5 document refs (< floor) but many PRs: documents keep all 5, and
    // the remaining 95 slots go to PRs — the floor never wastes capacity.
    const docRefs = Array.from({ length: 5 }, (_, i) => makeDocRef(i));
    const prRefs = Array.from({ length: 200 }, (_, i) => makePrRef(i + 1));
    const bounded = boundNonCommitArtifactRefs([...prRefs, ...docRefs]);

    assert.equal(bounded.length, MAX_SYNCED_ARTIFACT_REFS_PRODUCER);
    assert.equal(documentSlugs(bounded).length, 5, "all 5 document refs kept");
    const keptPrs = bounded.filter(
      (ref) => ref.kind === ArtifactRefTargetKind.PullRequest
    );
    assert.equal(
      keptPrs.length,
      MAX_SYNCED_ARTIFACT_REFS_PRODUCER - 5,
      "unused document reservation is handed to PR refs"
    );
  });
});

/**
 * ISS-5764: the prose-mention pass can mint hundreds of `referenced` PR/branch
 * refs on one orchestrator session. Without evidence-aware shedding, an
 * oldest-first slice of the non-document budget lets those mentions evict the
 * `created` ref for the PR the session actually AUTHORED — the ISS-4448 class
 * of silent loss, arriving through a different door.
 */
function makeProsePrRef(prNumber: number): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: "acme/repo",
    prNumber,
    method: ArtifactRefMethod.PrMentionInProse,
    relation: ArtifactRefRelation.Referenced,
  };
}

describe("ISS-5764: prose mentions are shed before command-derived refs", () => {
  test("an authored PR ref survives a flood of earlier prose mentions", () => {
    // 300 prose mentions ordered AHEAD of the authored ref, which is what the
    // extractor's oldest-first stream looks like when the session talks about
    // many PRs before opening its own.
    const authored = makePrRef(9999);
    const refs: SyncedArtifactRef[] = [
      ...Array.from({ length: 300 }, (_, i) => makeProsePrRef(i + 1)),
      authored,
    ];

    const kept = boundNonCommitArtifactRefs(refs);

    assert.ok(
      kept.length <= MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
      "producer budget must still be respected"
    );
    assert.ok(
      kept.some(
        (ref) =>
          ref.kind === ArtifactRefTargetKind.PullRequest &&
          ref.prNumber === 9999 &&
          ref.method === ArtifactRefMethod.PrUrlInToolUse
      ),
      "the authored PR ref must never be evicted by prose mentions"
    );
  });

  test("document refs keep their floor even under a prose flood", () => {
    const refs: SyncedArtifactRef[] = [
      ...Array.from({ length: 300 }, (_, i) => makeProsePrRef(i + 1)),
      ...Array.from({ length: 40 }, (_, i) => makeDocRef(i)),
    ];

    const kept = boundNonCommitArtifactRefs(refs);

    assert.equal(
      kept.filter(
        (ref) => ref.kind === ArtifactRefTargetKind.ClosedloopArtifact
      ).length,
      40
    );
  });

  test("kept refs remain a stable oldest-first subsequence of the input", () => {
    const refs: SyncedArtifactRef[] = [
      ...Array.from({ length: 300 }, (_, i) => makeProsePrRef(i + 1)),
      makePrRef(9999),
    ];

    const kept = boundNonCommitArtifactRefs(refs);
    const inputOrder = refs.filter((ref) => kept.includes(ref));

    assert.deepEqual(kept, inputOrder);
  });
});

/**
 * ISS-5764 (review falsification): prose mentions must consume only capacity
 * that documents, command refs, and the caller's commit refs all left unused.
 * Budgeting them as ordinary "other" refs was measurably destructive on
 * sessions that fit comfortably under the budget before the prose pass existed.
 */
describe("ISS-5764: prose mentions never starve documents or commits", () => {
  test("a session that fit under budget keeps all its documents and commits", () => {
    // 60 documents + 10 command PR refs + 30 commits = 70 refs, comfortably
    // under the 100-slot budget before prose existed.
    const nonCommit: SyncedArtifactRef[] = [
      ...Array.from({ length: 60 }, (_, i) => makeDocRef(i)),
      ...Array.from({ length: 10 }, (_, i) => makePrRef(9000 + i)),
      ...Array.from({ length: 500 }, (_, i) => makeProsePrRef(i + 1)),
    ];
    const commitCount = 30;

    const kept = boundNonCommitArtifactRefs(nonCommit, commitCount);

    assert.equal(
      kept.filter((r) => r.kind === ArtifactRefTargetKind.ClosedloopArtifact)
        .length,
      60,
      "all 60 document refs must survive"
    );
    assert.equal(
      kept.filter(
        (r) =>
          r.kind === ArtifactRefTargetKind.PullRequest &&
          r.method === ArtifactRefMethod.PrUrlInToolUse
      ).length,
      10,
      "all 10 command PR refs must survive"
    );
    // The caller appends commits from whatever this function left unspent.
    assert.ok(
      MAX_SYNCED_ARTIFACT_REFS_PRODUCER - kept.length >= commitCount,
      `all ${commitCount} commit refs must still fit; only ${MAX_SYNCED_ARTIFACT_REFS_PRODUCER - kept.length} slots left`
    );
  });

  test("prose mentions do take genuinely spare capacity", () => {
    const nonCommit: SyncedArtifactRef[] = [
      ...Array.from({ length: 5 }, (_, i) => makeDocRef(i)),
      ...Array.from({ length: 500 }, (_, i) => makeProsePrRef(i + 1)),
    ];

    const kept = boundNonCommitArtifactRefs(nonCommit, 0);

    assert.equal(kept.length, MAX_SYNCED_ARTIFACT_REFS_PRODUCER);
    assert.equal(
      kept.filter((r) => r.method === ArtifactRefMethod.PrMentionInProse)
        .length,
      MAX_SYNCED_ARTIFACT_REFS_PRODUCER - 5
    );
  });

  // Review falsification (wongk / codex, #4723): the pass-through gated on the
  // NON-COMMIT length alone, so a set that fit on its own never reached the
  // shedding path and prose evicted the caller's commits anyway.
  test("prose is shed when the non-commit set fits but the commits do not", () => {
    // 60 + 10 + 20 = 90 non-commit refs, under the 100-slot budget on their
    // own; with 30 commits the combined set is 120 and must be adjudicated.
    const nonCommit: SyncedArtifactRef[] = [
      ...Array.from({ length: 60 }, (_, i) => makeDocRef(i)),
      ...Array.from({ length: 10 }, (_, i) => makePrRef(9000 + i)),
      ...Array.from({ length: 20 }, (_, i) => makeProsePrRef(i + 1)),
    ];
    const commitCount = 30;

    const kept = boundNonCommitArtifactRefs(nonCommit, commitCount);

    assert.equal(
      kept.filter((r) => r.kind === ArtifactRefTargetKind.ClosedloopArtifact)
        .length,
      60,
      "all 60 document refs must survive"
    );
    assert.equal(
      kept.filter(
        (r) =>
          r.kind === ArtifactRefTargetKind.PullRequest &&
          r.method === ArtifactRefMethod.PrUrlInToolUse
      ).length,
      10,
      "all 10 command PR refs must survive"
    );
    assert.equal(
      kept.filter((r) => r.method === ArtifactRefMethod.PrMentionInProse)
        .length,
      0,
      "prose mentions must yield every slot the commits need"
    );
    assert.equal(
      MAX_SYNCED_ARTIFACT_REFS_PRODUCER - kept.length,
      commitCount,
      "the caller must be left with exactly its 30 commit slots"
    );
  });

  // The other direction: the widened gate must not start shedding on a set that
  // genuinely fits, or it would drop prose refs there is room for.
  test("a combined set that fits keeps its prose mentions untouched", () => {
    const nonCommit: SyncedArtifactRef[] = [
      ...Array.from({ length: 40 }, (_, i) => makeDocRef(i)),
      ...Array.from({ length: 20 }, (_, i) => makeProsePrRef(i + 1)),
    ];

    const kept = boundNonCommitArtifactRefs(nonCommit, 30);

    assert.deepEqual(kept, nonCommit);
  });

  // No prose in the array means the shedding path has nothing to shed, so the
  // widened gate must be a behavioural no-op for every pre-ISS-5764 session.
  test("without prose refs the widened gate changes nothing", () => {
    const nonCommit: SyncedArtifactRef[] = [
      ...Array.from({ length: 40 }, (_, i) => makeDocRef(i)),
      ...Array.from({ length: 50 }, (_, i) => makePrRef(9000 + i)),
    ];

    const kept = boundNonCommitArtifactRefs(nonCommit, 30);

    assert.deepEqual(kept, nonCommit);
  });
});

/**
 * ISS-6479: ISS-6060 began minting one `url_in_message` PR/branch ref per
 * GitHub link per human message — `url_match`/`referenced`/non-primary, the
 * same weakest-evidence class the prose tier exists for — but they landed in
 * the TOP budget tier. A link-heavy session saturated it and the caller's
 * `commitRefs.slice(0, 100 - bounded.length)` then kept ZERO commits, dropping
 * the `linesAdded`/`linesRemoved`/`filesChanged` that branch and PR LOC
 * attribution reads.
 *
 * The floods below are sized at `MAX_SYNCED_ARTIFACT_REFS_PRODUCER` rather than
 * an arbitrary larger number: these refs reach this budget through
 * `monitoredActivityOnlyRefsFromMetadata`, whose schema is `.max()`ed at that
 * same producer cap, so a bigger fixture would describe a set no production
 * session can hand this function. One cap's worth is already enough to starve
 * the caller's commits, which is the whole defect.
 */
function makeUrlPrRef(prNumber: number): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: "acme/repo",
    prNumber,
    method: ArtifactRefMethod.UrlInMessage,
    relation: ArtifactRefRelation.Referenced,
  };
}

function makeUrlDocRef(index: number): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    slug: `ISS-${index}`,
    isPrimary: false,
    method: ArtifactRefMethod.UrlInMessage,
    relation: ArtifactRefRelation.Referenced,
  };
}

describe("ISS-6479: pasted-URL refs are shed before commits and command refs", () => {
  test("a URL flood yields every slot the caller's commits need", () => {
    const nonCommit: SyncedArtifactRef[] = [
      ...Array.from({ length: 60 }, (_, i) => makeDocRef(i)),
      ...Array.from({ length: 10 }, (_, i) => makePrRef(9000 + i)),
      ...Array.from({ length: MAX_SYNCED_ARTIFACT_REFS_PRODUCER }, (_, i) =>
        makeUrlPrRef(i + 1)
      ),
    ];
    const commitCount = 30;

    const kept = boundNonCommitArtifactRefs(nonCommit, commitCount);

    assert.equal(
      kept.filter((r) => r.kind === ArtifactRefTargetKind.ClosedloopArtifact)
        .length,
      60,
      "all 60 document refs must survive"
    );
    assert.equal(
      kept.filter((r) => r.method === ArtifactRefMethod.PrUrlInToolUse).length,
      10,
      "all 10 command PR refs must survive"
    );
    assert.equal(
      kept.filter((r) => r.method === ArtifactRefMethod.UrlInMessage).length,
      0,
      "pasted URL refs must yield every slot the commits need"
    );
    assert.equal(
      MAX_SYNCED_ARTIFACT_REFS_PRODUCER - kept.length,
      commitCount,
      "the caller must be left with exactly its 30 commit slots"
    );
  });

  test("an authored PR ref survives a flood of earlier pasted URLs", () => {
    const refs: SyncedArtifactRef[] = [
      ...Array.from({ length: MAX_SYNCED_ARTIFACT_REFS_PRODUCER }, (_, i) =>
        makeUrlPrRef(i + 1)
      ),
      makePrRef(9999),
    ];

    const kept = boundNonCommitArtifactRefs(refs);

    assert.ok(
      kept.some(
        (ref) =>
          ref.kind === ArtifactRefTargetKind.PullRequest &&
          ref.prNumber === 9999 &&
          ref.method === ArtifactRefMethod.PrUrlInToolUse
      ),
      "the authored PR ref must never be evicted by pasted URL mentions"
    );
  });

  // `url_in_message` is ALSO how the extractor mints a ClosedLoop document URL
  // ref — the second-strongest primary-selection method. Those are documents,
  // not mentions, so the weak tier must classify on kind as well as method.
  // Documents FIRST here on purpose: it is the only order in which dropping the
  // kind guard is observable. A document already holds its own kind-filtered
  // slot, so counting it as weak too does not evict it — it burns the weak
  // tier's spare slots on refs that are already kept, and the pasted URLs that
  // tier exists to admit get nothing.
  test("document refs minted from a ClosedLoop URL are not weak-tier refs", () => {
    const docCount = 60;
    const refs: SyncedArtifactRef[] = [
      ...Array.from({ length: docCount }, (_, i) => makeUrlDocRef(i)),
      ...Array.from({ length: MAX_SYNCED_ARTIFACT_REFS_PRODUCER }, (_, i) =>
        makeUrlPrRef(i + 1)
      ),
    ];
    const commitCount = 20;

    const kept = boundNonCommitArtifactRefs(refs, commitCount);

    assert.equal(
      kept.filter((r) => r.kind === ArtifactRefTargetKind.ClosedloopArtifact)
        .length,
      docCount,
      "a document ref is never shed as weakest evidence for its method"
    );
    assert.equal(
      kept.filter((r) => r.kind === ArtifactRefTargetKind.PullRequest).length,
      MAX_SYNCED_ARTIFACT_REFS_PRODUCER - docCount - commitCount,
      "the weak tier's spare slots go to pasted URLs, not to already-kept documents"
    );
  });

  test("pasted URL refs do take genuinely spare capacity", () => {
    const nonCommit: SyncedArtifactRef[] = [
      ...Array.from({ length: 5 }, (_, i) => makeDocRef(i)),
      ...Array.from({ length: MAX_SYNCED_ARTIFACT_REFS_PRODUCER }, (_, i) =>
        makeUrlPrRef(i + 1)
      ),
    ];

    const kept = boundNonCommitArtifactRefs(nonCommit, 0);

    assert.equal(kept.length, MAX_SYNCED_ARTIFACT_REFS_PRODUCER);
    assert.equal(
      kept.filter((r) => r.method === ArtifactRefMethod.UrlInMessage).length,
      MAX_SYNCED_ARTIFACT_REFS_PRODUCER - 5,
      "nothing else wanted the slots, so the URL refs still ride along"
    );
  });
});
