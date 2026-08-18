import { describe, expect, it } from "vitest";
import {
  type ChunkGatingDecision,
  type ChunkGatingInput,
  resolveChunkGating,
} from "./chunk-revision-gating";

const NO_PENDING = {
  existingPendingRevision: null,
  existingPendingTotal: null,
  existingPendingReceived: null,
} satisfies Partial<ChunkGatingInput>;

function gate(overrides: Partial<ChunkGatingInput>) {
  return resolveChunkGating({
    incomingRevision: 1,
    chunk: null,
    existingRevision: null,
    ...NO_PENDING,
    ...overrides,
  });
}

describe("resolveChunkGating", () => {
  describe("unchunked whole session", () => {
    it("replaces and commits directly on a differing revision, staging nothing", () => {
      const d = gate({ incomingRevision: 5, existingRevision: 4, chunk: null });
      expect(d.shouldReplace).toBe(true);
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldCommitRevision).toBe(true);
      // Committing/unchunked clears all three markers (no-op when already NULL).
      expect(d.pendingChunkPatch).toEqual({
        pendingChunkRevision: null,
        pendingChunkTotal: null,
        pendingChunkReceived: null,
      });
    });

    it("does not replace when the revision is unchanged, but still clears any stale marker", () => {
      const d = gate({ incomingRevision: 4, existingRevision: 4, chunk: null });
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      expect(d.pendingChunkPatch).toEqual({
        pendingChunkRevision: null,
        pendingChunkTotal: null,
        pendingChunkReceived: null,
      });
    });
  });

  describe("in-order multi-chunk sequence", () => {
    it("chunk 0 replaces and stages revision/total/received=1 without committing", () => {
      const d = gate({
        incomingRevision: 7,
        existingRevision: 6,
        chunk: { index: 0, total: 3 },
      });
      expect(d.shouldReplace).toBe(true);
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      expect(d.pendingChunkPatch).toEqual({
        pendingChunkRevision: 7,
        pendingChunkTotal: 3,
        pendingChunkReceived: 1,
      });
    });

    it("interior chunk advances only the received-count, still not committing", () => {
      const d = gate({
        incomingRevision: 7,
        existingRevision: 6,
        chunk: { index: 1, total: 3 },
        existingPendingRevision: 7,
        existingPendingTotal: 3,
        existingPendingReceived: 1,
      });
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      expect(d.pendingChunkPatch).toEqual({ pendingChunkReceived: 2 });
    });

    it("last chunk of a complete sequence commits and clears the marker", () => {
      const d = gate({
        incomingRevision: 7,
        existingRevision: 6,
        chunk: { index: 2, total: 3 },
        existingPendingRevision: 7,
        existingPendingTotal: 3,
        existingPendingReceived: 2,
      });
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldCommitRevision).toBe(true);
      expect(d.pendingChunkPatch).toEqual({
        pendingChunkRevision: null,
        pendingChunkTotal: null,
        pendingChunkReceived: null,
      });
    });
  });

  describe("completeness — a dropped interior chunk must not commit", () => {
    it("last chunk does NOT commit when a leading chunk never arrived (gap)", () => {
      // chunk 0 staged received=1, then chunk 2 (last) arrives — chunk 1 was
      // dropped, so received stays at 1 (< total 3) and the commit is blocked.
      const d = gate({
        incomingRevision: 7,
        existingRevision: 6,
        chunk: { index: 2, total: 3 },
        existingPendingRevision: 7,
        existingPendingTotal: 3,
        existingPendingReceived: 1,
      });
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      // A gap chunk does not advance the count and leaves the marker in place.
      expect(d.pendingChunkPatch).toEqual({ pendingChunkReceived: 1 });
    });

    it("replaying an already-received interior chunk is idempotent (no double-count)", () => {
      const d = gate({
        incomingRevision: 7,
        existingRevision: 6,
        chunk: { index: 0, total: 3 },
        existingPendingRevision: 7,
        existingPendingTotal: 3,
        existingPendingReceived: 2,
      });
      // Chunk 0 re-fires shouldReplace and resets the count to 1 (a genuine
      // restart of the sequence), never inflating it past what has arrived.
      expect(d.shouldReplace).toBe(true);
      expect(d.pendingChunkPatch).toEqual({
        pendingChunkRevision: 7,
        pendingChunkTotal: 3,
        pendingChunkReceived: 1,
      });
    });
  });

  describe("foreign chunk — stale / out-of-order / no chunk 0 staged", () => {
    it("flags a non-first chunk when no sequence is staged (arrived before its chunk 0)", () => {
      const d = gate({
        incomingRevision: 7,
        existingRevision: 6,
        chunk: { index: 1, total: 3 },
        existingPendingRevision: null,
        existingPendingTotal: null,
        existingPendingReceived: null,
      });
      expect(d.isForeignChunk).toBe(true);
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      // A foreign chunk must not disturb the (absent) marker.
      expect(d.pendingChunkPatch).toEqual({});
    });

    it("flags a stale last chunk from a superseded revision while a newer sequence assembles", () => {
      // Sequence B (revision 8) is mid-apply (staged). A stale last chunk of the
      // OLD revision 7 arrives — its revision does not match the staged marker,
      // so it is foreign and must neither commit nor touch the marker.
      const d = gate({
        incomingRevision: 7,
        existingRevision: 6,
        chunk: { index: 2, total: 3 },
        existingPendingRevision: 8,
        existingPendingTotal: 3,
        existingPendingReceived: 1,
      });
      expect(d.isForeignChunk).toBe(true);
      expect(d.shouldCommitRevision).toBe(false);
      expect(d.pendingChunkPatch).toEqual({});
    });

    it("does NOT flag chunk 0 as foreign even when a different sequence is staged (it restarts)", () => {
      const d = gate({
        incomingRevision: 9,
        existingRevision: 6,
        chunk: { index: 0, total: 2 },
        existingPendingRevision: 8,
        existingPendingTotal: 3,
        existingPendingReceived: 1,
      });
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldReplace).toBe(true);
      expect(d.pendingChunkPatch).toEqual({
        pendingChunkRevision: 9,
        pendingChunkTotal: 2,
        pendingChunkReceived: 1,
      });
    });
  });

  describe("stale revision — old producer / new cloud (FEA-3595)", () => {
    it("rejects an unchunked payload whose revision is lower than the committed one", () => {
      const d = gate({
        incomingRevision: 39,
        existingRevision: 41,
        chunk: null,
      });
      expect(d.isForeignChunk).toBe(true);
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
    });

    it("rejects chunk 0 of a lower revision so it cannot open a stale sequence", () => {
      const d = gate({
        incomingRevision: 39,
        existingRevision: 41,
        chunk: { index: 0, total: 3 },
      });
      expect(d.isForeignChunk).toBe(true);
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      expect(d.pendingChunkPatch).toEqual({});
    });
  });

  describe("null / absent revision", () => {
    it("never commits or stages when the payload carries no dataRevision", () => {
      const d = gate({
        incomingRevision: null,
        existingRevision: 4,
        chunk: { index: 0, total: 2 },
      });
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
    });
  });

  // FEA-3595 review: the forward-only bar is max(committed, pending), not the
  // committed revision alone. Committed 39 with rev-41 chunk 0 already staged
  // is the exact interleaving that regressed: a delayed rev-40 payload still
  // "advances" against 39, so gating on the committed value alone lets it
  // delete-replace the rev-41 partial state and strand its remaining chunks.
  describe("high-water mark across committed and pending (FEA-3595)", () => {
    const STAGED_41_OVER_39 = {
      existingRevision: 39,
      existingPendingRevision: 41,
      existingPendingTotal: 3,
      existingPendingReceived: 1,
    } satisfies Partial<ChunkGatingInput>;

    it("rejects a delayed lower-revision UNCHUNKED payload that outranks only the committed revision", () => {
      const d = gate({
        ...STAGED_41_OVER_39,
        incomingRevision: 40,
        chunk: null,
      });
      expect(d.isForeignChunk).toBe(true);
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      // Critically: the staged rev-41 marker must survive untouched.
      expect(d.pendingChunkPatch).toEqual({});
    });

    it("rejects a delayed lower-revision CHUNK 0 that outranks only the committed revision", () => {
      const d = gate({
        ...STAGED_41_OVER_39,
        incomingRevision: 40,
        chunk: { index: 0, total: 2 },
      });
      expect(d.isForeignChunk).toBe(true);
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      expect(d.pendingChunkPatch).toEqual({});
    });

    it("still commits the staged higher sequence after the delayed payload was rejected", () => {
      const interior = gate({
        ...STAGED_41_OVER_39,
        incomingRevision: 41,
        chunk: { index: 1, total: 3 },
      });
      expect(interior.isForeignChunk).toBe(false);
      expect(interior.pendingChunkPatch.pendingChunkReceived).toBe(2);

      const last = gate({
        ...STAGED_41_OVER_39,
        existingPendingReceived: 2,
        incomingRevision: 41,
        chunk: { index: 2, total: 3 },
      });
      expect(last.isForeignChunk).toBe(false);
      expect(last.shouldCommitRevision).toBe(true);
    });

    it("preserves the same-pending chunk-0 restart so an interrupted sequence can repair itself", () => {
      const d = gate({
        ...STAGED_41_OVER_39,
        existingPendingReceived: 2,
        incomingRevision: 41,
        chunk: { index: 0, total: 3 },
      });
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldReplace).toBe(true);
      expect(d.shouldCommitRevision).toBe(false);
      // Re-opening resets the contiguous counter back to 1.
      expect(d.pendingChunkPatch).toEqual({
        pendingChunkRevision: 41,
        pendingChunkTotal: 3,
        pendingChunkReceived: 1,
      });
    });

    it("treats a payload equal to the committed revision as an idempotent no-op even with nothing staged", () => {
      const d = gate({
        incomingRevision: 41,
        existingRevision: 41,
        chunk: null,
      });
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
    });
  });

  describe("chunked re-send of the committed revision (ISS-6167)", () => {
    it("reports every chunk persisted, so the desktop's final-chunk ack can clear the outbox row", () => {
      const decisions = driveSequence({
        incomingRevision: 41,
        existingRevision: 41,
        total: 3,
      });

      // Every chunk must be echoed. Before the fix chunk 0 was accepted while
      // staging nothing, and chunks 1..2 came back foreign — the desktop then
      // logged "accepted but NOT persisted", discarded the tail, and re-prepared
      // from chunk 0 against this same committed revision, forever.
      expect(decisions.map((d) => d.isForeignChunk)).toEqual([
        false,
        false,
        false,
      ]);
    });

    it("STAGES the sequence on chunk 0 without delete-replacing the committed children", () => {
      const decisions = driveSequence({
        incomingRevision: 41,
        existingRevision: 41,
        total: 3,
      });

      // codex P1 on PR #4946: `shouldReplace` here would have
      // `persistSessionChildren` DELETE the committed event rows on chunk 0. The
      // revision stays committed while the children are partial, and reads do not
      // gate on `pendingChunkRevision`, so an interrupted re-send (client offline
      // or quit) leaves a formerly-complete session exposed as a partial one
      // indefinitely. Nothing is gained by it: the cloud only commits a revision
      // from a COMPLETE sequence, so at an UNCHANGED revision there is no stale
      // row for the replace to remove, and the events lane upserts on its
      // conflict key — the re-send restores identical rows without the delete.
      expect(decisions.map((d) => d.shouldReplace)).toEqual([
        false,
        false,
        false,
      ]);
      expect(decisions[0].pendingChunkPatch).toEqual({
        pendingChunkRevision: 41,
        pendingChunkTotal: 3,
        pendingChunkReceived: 1,
      });
      // Staging the marker is also what keeps gap detection and the
      // all-or-nothing commit alive on this path.
      expect(decisions[1].pendingChunkPatch).toEqual({
        pendingChunkReceived: 2,
      });
      expect(decisions.map((d) => d.shouldCommitRevision)).toEqual([
        false,
        false,
        true,
      ]);
      expect(decisions[2].pendingChunkPatch).toEqual({
        pendingChunkRevision: null,
        pendingChunkTotal: null,
        pendingChunkReceived: null,
      });
    });

    it("keeps the delete-replace on an ADVANCING sequence, so the carve-out is narrow", () => {
      // The suppression above is keyed to the committed revision ONLY. A genuine
      // advancing sequence still wipes the prior revision's children on chunk 0 —
      // there its stale rows really do have to go.
      const decisions = driveSequence({
        incomingRevision: 42,
        existingRevision: 41,
        total: 3,
      });
      expect(decisions.map((d) => d.shouldReplace)).toEqual([
        true,
        false,
        false,
      ]);
    });

    it("does not start deleting when chunk 0 RESTARTS a marker staged at the committed revision", () => {
      // The interrupted re-send resuming: a marker staged AT the committed
      // revision can only have come from an earlier re-open, which never deleted.
      // Letting the restart arm claim this one would reintroduce the P1 on the
      // exact retry the fix exists to serve.
      const d = gate({
        incomingRevision: 41,
        existingRevision: 41,
        existingPendingRevision: 41,
        existingPendingTotal: 3,
        existingPendingReceived: 2,
        chunk: { index: 0, total: 3 },
      });
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldReplace).toBe(false);
      // Still re-stages the sequence and resets the contiguous counter.
      expect(d.pendingChunkPatch).toEqual({
        pendingChunkRevision: 41,
        pendingChunkTotal: 3,
        pendingChunkReceived: 1,
      });
    });

    it("leaves a NEWER staged sequence untouched when a committed-revision chunk arrives late", () => {
      // committed 41 with 42 already assembling: the late 41 chunk is BELOW the
      // high-water mark, so it stays foreign and must not disturb 42's marker.
      // Without that, 42's remaining chunks strand as foreign no-ops forever —
      // the FEA-3595 regression this gate exists to prevent.
      const d = gate({
        incomingRevision: 41,
        existingRevision: 41,
        existingPendingRevision: 42,
        existingPendingTotal: 3,
        existingPendingReceived: 1,
        chunk: { index: 1, total: 3 },
      });
      expect(d.isForeignChunk).toBe(true);
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      expect(d.pendingChunkPatch).toEqual({});
    });

    it("still rejects a genuinely stale chunked re-send below the committed revision", () => {
      const decisions = driveSequence({
        incomingRevision: 40,
        existingRevision: 41,
        total: 3,
      });
      expect(decisions.every((d) => d.isForeignChunk)).toBe(true);
    });

    it("leaves an UNCHUNKED equal-revision payload the idempotent no-op it already was", () => {
      const d = gate({
        incomingRevision: 41,
        existingRevision: 41,
        chunk: { index: 0, total: 1 },
      });
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
    });
  });

  // wongk on PR #4946: a sequence's identity is the PAIR (revision, total). The
  // ISS-6167 re-open makes a re-prepared re-send at the COMMITTED revision a
  // routine event, so a re-send that also RE-CHUNKS is reachable — and judging
  // its chunks on revision alone lets a short sequence close a long one.
  describe("sequence identity is (revision, total), not the revision alone", () => {
    it("flags a non-first chunk whose total disagrees with the staged sequence", () => {
      const d = gate({
        incomingRevision: 41,
        existingRevision: 41,
        existingPendingRevision: 41,
        existingPendingTotal: 100,
        existingPendingReceived: 1,
        chunk: { index: 1, total: 2 },
      });
      expect(d.isForeignChunk).toBe(true);
      expect(d.shouldCommitRevision).toBe(false);
      // The 100-chunk sequence's marker must survive the intruder untouched.
      expect(d.pendingChunkPatch).toEqual({});
    });

    it("does not commit a 2-chunk re-send over a marker staged at 100 chunks", () => {
      // The exact reported interleave: chunk 0-of-100 stages, then the desktop
      // re-prepares at a smaller chunking and its chunk 1-of-2 lands. Judged on
      // revision alone that chunk is positionally LAST and `receivedAfter` (2)
      // clears its OWN total (2) — committing two chunks of a hundred-chunk
      // session as a complete `dataRevision` and clearing the marker.
      const staged = gate({
        incomingRevision: 41,
        existingRevision: 41,
        chunk: { index: 0, total: 100 },
      });
      expect(staged.pendingChunkPatch).toEqual({
        pendingChunkRevision: 41,
        pendingChunkTotal: 100,
        pendingChunkReceived: 1,
      });

      const rechunkedTail = gate({
        incomingRevision: 41,
        existingRevision: 41,
        existingPendingRevision: staged.pendingChunkPatch.pendingChunkRevision,
        existingPendingTotal: staged.pendingChunkPatch.pendingChunkTotal,
        existingPendingReceived: staged.pendingChunkPatch.pendingChunkReceived,
        chunk: { index: 1, total: 2 },
      });
      expect(rechunkedTail.isForeignChunk).toBe(true);
      expect(rechunkedTail.shouldCommitRevision).toBe(false);
      expect(rechunkedTail.pendingChunkPatch).toEqual({});
    });

    it("lets the re-chunked sequence repair itself from its own chunk 0", () => {
      // Rejecting the tail is not a dead end: chunk 0 of the NEW chunking
      // re-stages the marker at the new total, after which its own tail matches
      // and commits. Otherwise the fix above would trade a wrong commit for the
      // ISS-6167 livelock it was written to end.
      const restaged = gate({
        incomingRevision: 41,
        existingRevision: 41,
        existingPendingRevision: 41,
        existingPendingTotal: 100,
        existingPendingReceived: 1,
        chunk: { index: 0, total: 2 },
      });
      expect(restaged.isForeignChunk).toBe(false);
      expect(restaged.pendingChunkPatch).toEqual({
        pendingChunkRevision: 41,
        pendingChunkTotal: 2,
        pendingChunkReceived: 1,
      });

      const tail = gate({
        incomingRevision: 41,
        existingRevision: 41,
        existingPendingRevision: 41,
        existingPendingTotal: 2,
        existingPendingReceived: 1,
        chunk: { index: 1, total: 2 },
      });
      expect(tail.isForeignChunk).toBe(false);
      expect(tail.shouldCommitRevision).toBe(true);
    });

    it("flags a matching-revision chunk when no total was ever staged", () => {
      // A marker row carrying a revision but no total is not a sequence this
      // gate ever wrote (chunk 0 stages all three columns together), so a chunk
      // measured against it must not advance or commit.
      const d = gate({
        incomingRevision: 41,
        existingRevision: 40,
        existingPendingRevision: 41,
        existingPendingTotal: null,
        existingPendingReceived: 1,
        chunk: { index: 1, total: 2 },
      });
      expect(d.isForeignChunk).toBe(true);
      expect(d.shouldCommitRevision).toBe(false);
      expect(d.pendingChunkPatch).toEqual({});
    });
  });
});

/**
 * Drive a whole chunked sequence the way the per-session apply does: feed each
 * decision's `pendingChunkPatch` forward as the next chunk's persisted staging
 * state, so a chunk can only be judged against what its predecessors actually
 * wrote. An omitted patch key leaves the persisted value untouched.
 */
function driveSequence(args: {
  incomingRevision: number;
  existingRevision: number | null;
  total: number;
}) {
  let pendingRevision: number | null = null;
  let pendingTotal: number | null = null;
  let pendingReceived: number | null = null;
  const decisions: ChunkGatingDecision[] = [];
  for (let index = 0; index < args.total; index += 1) {
    const decision = resolveChunkGating({
      incomingRevision: args.incomingRevision,
      existingRevision: args.existingRevision,
      existingPendingRevision: pendingRevision,
      existingPendingTotal: pendingTotal,
      existingPendingReceived: pendingReceived,
      chunk: { index, total: args.total },
    });
    const patch = decision.pendingChunkPatch;
    pendingRevision =
      "pendingChunkRevision" in patch
        ? (patch.pendingChunkRevision ?? null)
        : pendingRevision;
    pendingTotal =
      "pendingChunkTotal" in patch
        ? (patch.pendingChunkTotal ?? null)
        : pendingTotal;
    pendingReceived =
      "pendingChunkReceived" in patch
        ? (patch.pendingChunkReceived ?? null)
        : pendingReceived;
    decisions.push(decision);
  }
  return decisions;
}
