import { describe, expect, it } from "vitest";
import {
  type ChunkGatingDecision,
  type ChunkGatingInput,
  type PendingChunkPatch,
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

    it("chunk 0 re-firing on a partly-received sequence resets the counter rather than inflating it", () => {
      // ISS-8131: this case is named for what it actually drives. Index 0 is
      // not an INTERIOR chunk — it takes the `startsSequence` arm, not the
      // `chunkIndex < priorReceived` replay arm. The genuine interior replay is
      // covered in "outbox replay of an interior chunk" below.
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
    it("never commits, and stages no REVISION, when a chunked payload carries no dataRevision", () => {
      const d = gate({
        incomingRevision: null,
        existingRevision: 4,
        chunk: { index: 0, total: 2 },
      });
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      // ISS-8131: this case was named "never commits OR STAGES" while asserting
      // neither. It does stage — the contiguous counter advances — so the name
      // now claims only what the patch shows: no revision is staged, which is
      // why every later chunk of such a sequence reads a null `stagedRevision`
      // and comes back foreign. That limb is a separate defect, pinned (not
      // fixed) in the ISS-8131 block below.
      expect(d.pendingChunkPatch).toEqual({ pendingChunkReceived: 1 });
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

  // whitlockk on PR #4946: a sequence's identity is the PAIR (revision, total). The
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

  // ISS-8131 BUG 2. `dataRevision` is `.nullish()` on the wire, so a payload
  // carrying none is a first-class shape — an older desktop sends none, and
  // `wire-data-revision.ts` folds the unchunked MAINTENANCE_STALE sentinel to
  // the same thing. An UNCHUNKED one is never foreign — `isStaleRevision` shorts
  // on `incoming != null`, and the following-chunk arm cannot apply to chunk 0 —
  // so before the fix it reached the clear arm and nulled all three columns of a
  // sequence it had no claim to. (A revision-less FOLLOWING chunk is foreign;
  // the orphan case below covers what that costs.)
  describe("a revision-less unchunked payload must not end a sequence it does not own (ISS-8131)", () => {
    const ASSEMBLING_41_OVER_39 = {
      existingRevision: 39,
      existingPendingRevision: 41,
      existingPendingTotal: 3,
      existingPendingReceived: 1,
    } satisfies Partial<ChunkGatingInput>;

    it("omits all three pending keys so the staged marker survives", () => {
      const d = gate({
        ...ASSEMBLING_41_OVER_39,
        incomingRevision: null,
        chunk: null,
      });
      // Not foreign, and not committing — which is exactly why it used to fall
      // into the unchunked clear.
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      expect(d.pendingChunkPatch).toEqual({});
    });

    // ISS-8131: the marker surviving is only half the fix. `{}` stops the wipe
    // but the payload still applies ADDITIVELY, so the caller needs a separate
    // signal to withhold its children. Each case below fixes one arm of that
    // condition — drop any one and a real shape changes answer.
    it("flags a revision-less UNCHUNKED payload landing mid-sequence", () => {
      expect(
        gate({
          ...ASSEMBLING_41_OVER_39,
          incomingRevision: null,
          chunk: null,
        }).revisionlessMidSequence
      ).toBe(true);
    });

    it("flags a revision-less CHUNK 0 landing mid-sequence, which the unchunked guard alone does not cover", () => {
      // No live producer emits this today (the wire fold skips chunked
      // sentinel-0), but it reaches the identical additive path, so one
      // condition closes both rather than leaving a latent twin.
      expect(
        gate({
          ...ASSEMBLING_41_OVER_39,
          incomingRevision: null,
          chunk: { index: 0, total: 3 },
        }).revisionlessMidSequence
      ).toBe(true);
    });

    it("does NOT flag a revision-less payload when no sequence is staged", () => {
      // The ordinary older-desktop delivery. Holding it would strand a client
      // that has done nothing wrong, so the staged marker is load-bearing.
      expect(
        gate({
          ...NO_PENDING,
          existingRevision: 39,
          incomingRevision: null,
          chunk: null,
        }).revisionlessMidSequence
      ).toBe(false);
    });

    it("does NOT flag a payload that carries a real revision mid-sequence", () => {
      expect(
        gate({
          ...ASSEMBLING_41_OVER_39,
          incomingRevision: 41,
          chunk: { index: 1, total: 3 },
        }).revisionlessMidSequence
      ).toBe(false);
    });

    it("does NOT flag a revision-less FOLLOWING chunk — already refused as foreign", () => {
      const d = gate({
        ...ASSEMBLING_41_OVER_39,
        incomingRevision: null,
        chunk: { index: 1, total: 3 },
      });
      expect(d.isForeignChunk).toBe(true);
      // Foreign already no-writes unconditionally; flagging it too would make
      // the caller's two refusal paths overlap and hide which one fired.
      expect(d.revisionlessMidSequence).toBe(false);
    });

    it("lets the interrupted rev-41 sequence still complete and commit", () => {
      // `{}` on its own does not prove the sequence SURVIVED — only driving the
      // tail against the state that payload left behind does. Before the fix
      // the marker was gone here and both chunks below came back foreign.
      let pending: PendingState = {
        existingPendingRevision: 41,
        existingPendingTotal: 3,
        existingPendingReceived: 1,
      };
      pending = applyPendingPatch(
        pending,
        gate({ ...ASSEMBLING_41_OVER_39, incomingRevision: null, chunk: null })
          .pendingChunkPatch
      );
      expect(pending).toEqual({
        existingPendingRevision: 41,
        existingPendingTotal: 3,
        existingPendingReceived: 1,
      });

      const interior = resolveChunkGating({
        ...pending,
        incomingRevision: 41,
        existingRevision: 39,
        chunk: { index: 1, total: 3 },
      });
      expect(interior.isForeignChunk).toBe(false);
      pending = applyPendingPatch(pending, interior.pendingChunkPatch);

      const last = resolveChunkGating({
        ...pending,
        incomingRevision: 41,
        existingRevision: 39,
        chunk: { index: 2, total: 3 },
      });
      expect(last.isForeignChunk).toBe(false);
      expect(last.shouldCommitRevision).toBe(true);
    });

    it("keeps an ABANDONED marker too — the disclosed cost of the fix", () => {
      // The gate is pure, so it cannot tell a live sequence from one whose tail
      // will never arrive: this is the SAME input as the case above. Before the
      // fix a revision-less payload cleared an abandoned marker as a side
      // effect; that garbage collection is what the fix gives up, deliberately.
      // A payload at a revision >= the staged one still clears it, and so does
      // the desktop's own `abandonUnpersistedChunkTail` re-send from chunk 0.
      const d = gate({
        existingRevision: 39,
        existingPendingRevision: 41,
        existingPendingTotal: 3,
        existingPendingReceived: 1,
        incomingRevision: null,
        chunk: null,
      });
      expect(d.pendingChunkPatch).toEqual({});
    });

    it("leaves a chunked chunk-0 ORPHAN counter alone (behaviour pinned, not fixed)", () => {
      // A chunked chunk 0 carrying no revision stages a counter beside a NULL
      // revision, so its own later chunks come back foreign. That limb is a
      // separate defect and is deliberately NOT fixed here. What changes is
      // that the orphan now SURVIVES a later revision-less payload instead of
      // being cleared by it — pinned so the next reader does not read it as
      // unchanged.
      const orphaning = gate({
        incomingRevision: null,
        existingRevision: 4,
        chunk: { index: 0, total: 2 },
      });
      expect(orphaning.pendingChunkPatch).toEqual({ pendingChunkReceived: 1 });

      const later = gate({
        incomingRevision: null,
        existingRevision: 4,
        chunk: null,
        existingPendingRevision: null,
        existingPendingTotal: null,
        existingPendingReceived: 1,
      });
      expect(later.pendingChunkPatch).toEqual({});
    });
  });

  describe("high-water mark when NOTHING is committed yet (ISS-8131 item 7)", () => {
    it("flags a lower unchunked payload as foreign against a pending-only session", () => {
      // A brand-new session whose FIRST chunked sequence is mid-assembly, hit
      // by a lower-revision whole-session payload. The bar is
      // max(committed, pending) and committed is NULL here, so the pending
      // revision alone has to carry it — the limb no other case executes.
      const d = gate({
        incomingRevision: 5,
        chunk: null,
        existingRevision: null,
        existingPendingRevision: 7,
        existingPendingTotal: 3,
        existingPendingReceived: 1,
      });
      // Mutating `maxRevision`'s `return pending ?? null` to `return null` makes
      // this payload "advance" against a null bar: foreign flips false,
      // shouldReplace flips true, and it delete-replaces the assembling rev-7
      // partial and commits rev 5.
      expect(d.isForeignChunk).toBe(true);
      expect(d.shouldReplace).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      expect(d.pendingChunkPatch).toEqual({});
    });
  });

  describe("outbox replay of an interior chunk (ISS-8131 item 8)", () => {
    const ASSEMBLING_7_OF_4 = {
      incomingRevision: 7,
      existingRevision: 6,
      existingPendingRevision: 7,
      existingPendingTotal: 4,
      existingPendingReceived: 3,
    } satisfies Partial<ChunkGatingInput>;

    it("leaves the contiguous counter unchanged when chunk 1 is redelivered", () => {
      // Chunks 0,1,2 landed; the bounded-retry outbox redelivers chunk 1.
      const d = gate({ ...ASSEMBLING_7_OF_4, chunk: { index: 1, total: 4 } });
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldCommitRevision).toBe(false);
      // Neither inflated to 4 nor regressed to 2. A mutant returning
      // `chunkIndex + 1` here writes 2, after which chunk 3 finds
      // `index !== priorReceived`, never advances, and the sequence can never
      // commit until a fresh chunk 0.
      expect(d.pendingChunkPatch).toEqual({ pendingChunkReceived: 3 });
    });

    it("still commits on the real last chunk after that replay", () => {
      const d = gate({ ...ASSEMBLING_7_OF_4, chunk: { index: 3, total: 4 } });
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldCommitRevision).toBe(true);
      // The completing chunk CLEARS the marker; it does not leave a count of 4.
      expect(d.pendingChunkPatch).toEqual({
        pendingChunkRevision: null,
        pendingChunkTotal: null,
        pendingChunkReceived: null,
      });
    });
  });

  describe("unchunked payload AT the revision a sequence is assembling (ISS-8131 item 9)", () => {
    it("replaces and commits, abandoning the staged sequence", () => {
      // Reachable when the desktop re-prepares a session that shrank below the
      // chunking threshold, or when two producers race the same
      // externalSessionId. This pins CURRENT behaviour: the module header
      // describes the equal-to-COMMITTED unchunked case as an idempotent no-op
      // and is silent on equal-to-PENDING, which is what this is.
      const d = gate({
        incomingRevision: 41,
        existingRevision: 39,
        chunk: null,
        existingPendingRevision: 41,
        existingPendingTotal: 3,
        existingPendingReceived: 1,
      });
      expect(d.isForeignChunk).toBe(false);
      expect(d.shouldReplace).toBe(true);
      expect(d.shouldCommitRevision).toBe(true);
      expect(d.pendingChunkPatch).toEqual({
        pendingChunkRevision: null,
        pendingChunkTotal: null,
        pendingChunkReceived: null,
      });
    });

    it("strands the abandoned sequence's remaining chunks as foreign no-ops", () => {
      // The other half of the same story: rev 41 is now committed and nothing
      // is staged, so the old sequence's chunk 1 has no marker to match.
      const d = gate({
        incomingRevision: 41,
        existingRevision: 41,
        chunk: { index: 1, total: 3 },
      });
      expect(d.isForeignChunk).toBe(true);
      expect(d.shouldCommitRevision).toBe(false);
      expect(d.pendingChunkPatch).toEqual({});
    });
  });
});

/** The three persisted staging columns a decision's patch is applied to. */
type PendingState = {
  existingPendingRevision: number | null;
  existingPendingTotal: number | null;
  existingPendingReceived: number | null;
};

/**
 * Apply a decision's patch the way the per-session apply's spread does: an
 * omitted key leaves the persisted value untouched, an explicit `null` clears
 * it. ONE definition, so a test that threads a sequence by hand and
 * {@link driveSequence} cannot drift on what an omitted key means.
 */
function applyPendingPatch(
  state: PendingState,
  patch: PendingChunkPatch
): PendingState {
  return {
    existingPendingRevision:
      "pendingChunkRevision" in patch
        ? (patch.pendingChunkRevision ?? null)
        : state.existingPendingRevision,
    existingPendingTotal:
      "pendingChunkTotal" in patch
        ? (patch.pendingChunkTotal ?? null)
        : state.existingPendingTotal,
    existingPendingReceived:
      "pendingChunkReceived" in patch
        ? (patch.pendingChunkReceived ?? null)
        : state.existingPendingReceived,
  };
}

/**
 * Drive a whole chunked sequence the way the per-session apply does: feed each
 * decision's `pendingChunkPatch` forward as the next chunk's persisted staging
 * state, so a chunk can only be judged against what its predecessors actually
 * wrote.
 */
function driveSequence(args: {
  incomingRevision: number;
  existingRevision: number | null;
  total: number;
}) {
  let pending: PendingState = NO_PENDING;
  const decisions: ChunkGatingDecision[] = [];
  for (let index = 0; index < args.total; index += 1) {
    const decision = resolveChunkGating({
      ...pending,
      incomingRevision: args.incomingRevision,
      existingRevision: args.existingRevision,
      chunk: { index, total: args.total },
    });
    pending = applyPendingPatch(pending, decision.pendingChunkPatch);
    decisions.push(decision);
  }
  return decisions;
}
