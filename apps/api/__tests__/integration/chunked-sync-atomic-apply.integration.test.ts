/**
 * FEA-3474 (PRD-536 D3) — atomic chunked-session apply: a partial, stale, or
 * out-of-order chunk sequence must never leave a persisted half-session that
 * masquerades as a complete `dataRevision`.
 *
 * FEA-3788 already made the happy interruption path repairable (chunk 0
 * delete-replaces; the last chunk commits the revision). FEA-3474 hardens that
 * against the stale-partial-set collision the positional `isLastChunk` check
 * left open:
 *   - a FOREIGN chunk (a non-first chunk whose revision does not match the
 *     sequence chunk 0 staged) is a NO-OP — it never mutates the live event or
 *     detail rows, so its events cannot contaminate the set the real sequence is
 *     assembling; and
 *   - the last chunk commits `dataRevision` only when its revision matches the
 *     staged marker AND every leading chunk arrived (completeness), so a dropped
 *     interior chunk cannot commit over a gap.
 *
 * These tests drive the REAL cloud ingress contract
 * (`parseDesktopAgentSessionsPayload`) + `agentSessionsService.upsertSessions`
 * against Postgres and read the persisted `agent_session_events` + revision/
 * marker columns back directly, so atomicity is proven by the STORE, not by logs.
 */
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  buildSessionChunk,
  type ChunkMeta,
  type ChunkSyncContext,
  createComputeTarget,
  ingestChunk,
  readPersistedChunkState,
} from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createTestOrganization,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "@/__tests__/utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const EXTERNAL_SESSION_ID = "sess-fea-3474-atomic";
const SESSION_NAME = "FEA-3474 atomic chunked session";
const BATCH_ID = "00000000-0000-4000-8000-000000000474";
const REVISION_A = 10;
const REVISION_B = 11;

type SessionPayloadParams = {
  eventIds: string[];
  /** Omit for an unchunked whole-session payload. */
  chunk?: ChunkMeta | null;
  /** Omit for a payload carrying no `dataRevision`. */
  dataRevision?: number | null;
};

function chunk(params: SessionPayloadParams): Record<string, unknown> {
  return buildSessionChunk({
    externalSessionId: EXTERNAL_SESSION_ID,
    name: SESSION_NAME,
    ...params,
  });
}

/** Resolves to the batch's ack echo (`persistedSessionIds`). */
function apply(
  context: ChunkSyncContext,
  params: SessionPayloadParams,
  // ISS-8131: OMITTED by default, the pre-#4862 wire shape every case in this
  // file sent before this parameter existed. Pass `wantsAcceptedSessionIds` to
  // drive the modern client — the cloud's HOLD arms are unreachable without it.
  envelope: { wantsAcceptedSessionIds?: boolean } = {}
): Promise<string[]> {
  return ingestChunk(context, BATCH_ID, chunk(params), envelope);
}

function readState(context: ChunkSyncContext) {
  return readPersistedChunkState(context.computeTargetId, EXTERNAL_SESSION_ID);
}

async function setup(): Promise<ChunkSyncContext> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    user.id,
    "fea-3474"
  );
  return { organizationId, userId: user.id, computeTargetId };
}

describeIfDb("atomic chunked-session apply (FEA-3474, PRD-536 D3)", () => {
  it("does not commit the revision until the last chunk of the SAME sequence lands (partial sequence persists nothing final)", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const context = await setup();

      // Chunk 0 of a 3-chunk sequence lands, then the process dies.
      await apply(context, {
        eventIds: ["a0", "a1"],
        chunk: { index: 0, total: 3 },
        dataRevision: REVISION_A,
      });

      const afterPartial = await readState(context);
      // Only chunk-0 events; revision NOT committed; the sequence is staged as
      // in-progress (revision + total + received=1) so a mismatched chunk can
      // never close it.
      expect(afterPartial?.eventIds).toEqual(["a0", "a1"]);
      expect(afterPartial?.dataRevision).toBeNull();
      expect(afterPartial?.pendingChunkRevision).toBe(REVISION_A);
      expect(afterPartial?.pendingChunkTotal).toBe(3);
      expect(afterPartial?.pendingChunkReceived).toBe(1);
    });
  });

  it("no-ops a stale LAST chunk from a superseded revision — its events never contaminate the in-progress sequence", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const context = await setup();

      // A NEW revision B sequence opens (chunk 0 delete-replaces, stages B).
      await apply(context, {
        eventIds: ["b0", "b1"],
        chunk: { index: 0, total: 2 },
        dataRevision: REVISION_B,
      });

      // A STALE, in-flight LAST chunk from an OLDER revision A arrives late and
      // out of order. It is positionally `isLastChunk`, but its revision (A) does
      // not match the staged sequence (B), so it is FOREIGN: a no-op that neither
      // commits A nor appends its "a-late" event into the assembling B set.
      await apply(context, {
        eventIds: ["a-late"],
        chunk: { index: 2, total: 3 },
        dataRevision: REVISION_A,
      });

      const afterStale = await readState(context);
      // The stale event did NOT append (foreign no-op); revision uncommitted; the
      // in-progress marker is still B — the half-session cannot masquerade as A.
      expect(afterStale?.eventIds).toEqual(["b0", "b1"]);
      expect(afterStale?.dataRevision).toBeNull();
      expect(afterStale?.pendingChunkRevision).toBe(REVISION_B);

      // The real revision-B sequence completes in order → commits B atomically.
      await apply(context, {
        eventIds: ["b0", "b1"],
        chunk: { index: 0, total: 2 },
        dataRevision: REVISION_B,
      });
      await apply(context, {
        eventIds: ["b2", "b3"],
        chunk: { index: 1, total: 2 },
        dataRevision: REVISION_B,
      });

      const afterRepair = await readState(context);
      // Only revision-B events remain (never any "a-late"); B is committed; the
      // marker is cleared.
      expect(afterRepair?.eventIds).toEqual(["b0", "b1", "b2", "b3"]);
      expect(afterRepair?.dataRevision).toBe(REVISION_B);
      expect(afterRepair?.pendingChunkRevision).toBeNull();
    });
  });

  it("no-ops a lone LAST chunk that arrives before its own chunk 0 (nothing is persisted)", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const context = await setup();

      // The LAST chunk of a fresh session arrives first (reordered delivery). No
      // chunk 0 has staged the sequence, so it is FOREIGN and a no-op — it must
      // not even create the session row with a partial event set.
      await apply(context, {
        eventIds: ["last-first"],
        chunk: { index: 1, total: 2 },
        dataRevision: REVISION_A,
      });

      // No SessionDetail row was created by the skipped foreign chunk.
      expect(await readState(context)).toBeNull();

      // Now chunk 0 lands and opens the sequence; then it completes in order.
      await apply(context, {
        eventIds: ["a0"],
        chunk: { index: 0, total: 2 },
        dataRevision: REVISION_A,
      });
      await apply(context, {
        eventIds: ["a1"],
        chunk: { index: 1, total: 2 },
        dataRevision: REVISION_A,
      });

      const afterRepair = await readState(context);
      // Only the in-order sequence's events — never the reordered "last-first".
      expect(afterRepair?.eventIds).toEqual(["a0", "a1"]);
      expect(afterRepair?.dataRevision).toBe(REVISION_A);
      expect(afterRepair?.pendingChunkRevision).toBeNull();
    });
  });

  it("does NOT commit the revision when an interior chunk was dropped (completeness gap)", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const context = await setup();

      // Chunk 0 opens a 3-chunk sequence (staged received=1).
      await apply(context, {
        eventIds: ["a0"],
        chunk: { index: 0, total: 3 },
        dataRevision: REVISION_A,
      });

      // Chunk 1 is DROPPED. The LAST chunk (index 2) then lands: it belongs to
      // the staged sequence (revision matches) but the contiguous received-count
      // is still 1 (< total 3), so the revision must NOT commit over the gap.
      await apply(context, {
        eventIds: ["a2"],
        chunk: { index: 2, total: 3 },
        dataRevision: REVISION_A,
      });

      const afterGap = await readState(context);
      expect(afterGap?.dataRevision).toBeNull();
      expect(afterGap?.pendingChunkRevision).toBe(REVISION_A);
      // The gap chunk did not advance the contiguous count.
      expect(afterGap?.pendingChunkReceived).toBe(1);

      // The missing interior chunk finally arrives, then the last chunk again →
      // the sequence is now complete and commits atomically.
      await apply(context, {
        eventIds: ["a1"],
        chunk: { index: 1, total: 3 },
        dataRevision: REVISION_A,
      });
      await apply(context, {
        eventIds: ["a2"],
        chunk: { index: 2, total: 3 },
        dataRevision: REVISION_A,
      });

      const afterComplete = await readState(context);
      expect(afterComplete?.eventIds).toEqual(["a0", "a1", "a2"]);
      expect(afterComplete?.dataRevision).toBe(REVISION_A);
      expect(afterComplete?.pendingChunkRevision).toBeNull();
    });
  });

  it("commits atomically and clears the marker when the full sequence lands in order", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const context = await setup();

      await apply(context, {
        eventIds: ["a0", "a1"],
        chunk: { index: 0, total: 2 },
        dataRevision: REVISION_A,
      });
      const midway = await readState(context);
      expect(midway?.dataRevision).toBeNull();
      expect(midway?.pendingChunkRevision).toBe(REVISION_A);

      await apply(context, {
        eventIds: ["a2", "a3"],
        chunk: { index: 1, total: 2 },
        dataRevision: REVISION_A,
      });

      const persisted = await readState(context);
      expect(persisted?.eventIds).toEqual(["a0", "a1", "a2", "a3"]);
      expect(persisted?.dataRevision).toBe(REVISION_A);
      expect(persisted?.pendingChunkRevision).toBeNull();
    });
  });

  it("ISS-6167: a chunked RE-SEND at the committed revision acks every chunk, keeps the committed snapshot whole, and clears the marker", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const context = await setup();

      // A COMPLETE session is already committed at REVISION_A.
      await apply(context, {
        eventIds: ["a0", "a1", "a2", "a3"],
        chunk: { index: 0, total: 1 },
        dataRevision: REVISION_A,
      });
      const committed = await readState(context);
      expect(committed?.eventIds).toEqual(["a0", "a1", "a2", "a3"]);
      expect(committed?.dataRevision).toBe(REVISION_A);

      // The desktop now re-sends that SAME revision CHUNKED — the session
      // crossed the per-request payload cap without its data changing. Pre-fix
      // chunk 0 staged no marker, so chunks 1..2 came back FOREIGN and their id
      // was WITHHELD from the ack echo; the desktop read "accepted but not
      // persisted", kept the outbox row, and re-prepared from chunk 0 forever.
      const ackChunk0 = await apply(context, {
        eventIds: ["a0", "a1"],
        chunk: { index: 0, total: 3 },
        dataRevision: REVISION_A,
      });
      expect(ackChunk0).toEqual([EXTERNAL_SESSION_ID]);

      // codex P1 on PR #4946: chunk 0 must NOT delete-replace the committed
      // children. `dataRevision` stays committed here and read projections do
      // not gate on `pendingChunkRevision`, so a re-send interrupted at this
      // point would otherwise expose a complete session as a partial one
      // indefinitely. Proven against the STORE: every committed event survives
      // a chunk 0 that carried only half of them.
      const afterFirstChunk = await readState(context);
      expect(afterFirstChunk?.eventIds).toEqual(["a0", "a1", "a2", "a3"]);
      expect(afterFirstChunk?.dataRevision).toBe(REVISION_A);
      expect(afterFirstChunk?.pendingChunkRevision).toBe(REVISION_A);
      expect(afterFirstChunk?.pendingChunkTotal).toBe(3);
      expect(afterFirstChunk?.pendingChunkReceived).toBe(1);

      const ackChunk1 = await apply(context, {
        eventIds: ["a2"],
        chunk: { index: 1, total: 3 },
        dataRevision: REVISION_A,
      });
      const ackChunk2 = await apply(context, {
        eventIds: ["a3"],
        chunk: { index: 2, total: 3 },
        dataRevision: REVISION_A,
      });
      // The whole point of the fix: server truth says every chunk persisted, so
      // the desktop's outbox row for each one is cleared by the ack echo instead
      // of being re-prepared against this same committed revision forever.
      expect(ackChunk1).toEqual([EXTERNAL_SESSION_ID]);
      expect(ackChunk2).toEqual([EXTERNAL_SESSION_ID]);

      const afterResend = await readState(context);
      expect(afterResend?.eventIds).toEqual(["a0", "a1", "a2", "a3"]);
      expect(afterResend?.dataRevision).toBe(REVISION_A);
      expect(afterResend?.pendingChunkRevision).toBeNull();
      expect(afterResend?.pendingChunkTotal).toBeNull();
      expect(afterResend?.pendingChunkReceived).toBeNull();
    });
  });

  it("ISS-6166 review: a re-send RE-CHUNKED at a smaller total cannot close the staged sequence", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const context = await setup();

      // Committed at REVISION_A, then re-sent chunked as a 4-chunk sequence of
      // which only chunk 0 lands.
      await apply(context, {
        eventIds: ["a0", "a1", "a2", "a3"],
        chunk: { index: 0, total: 1 },
        dataRevision: REVISION_A,
      });
      await apply(context, {
        eventIds: ["a0"],
        chunk: { index: 0, total: 4 },
        dataRevision: REVISION_A,
      });

      // The desktop re-prepares at a SMALLER chunking and its positionally-last
      // chunk 1-of-2 lands on the 4-chunk marker. Same revision, different
      // sequence: judged on revision alone it would clear its own total and
      // COMMIT, closing a four-chunk sequence with two chunks' events and
      // clearing the marker. It must be a foreign no-op instead — withheld from
      // the ack echo, with the staged 4-chunk marker untouched.
      const ack = await apply(context, {
        eventIds: ["rechunked"],
        chunk: { index: 1, total: 2 },
        dataRevision: REVISION_A,
      });
      expect(ack).toEqual([]);

      const afterRechunkedTail = await readState(context);
      expect(afterRechunkedTail?.eventIds).toEqual(["a0", "a1", "a2", "a3"]);
      expect(afterRechunkedTail?.pendingChunkRevision).toBe(REVISION_A);
      expect(afterRechunkedTail?.pendingChunkTotal).toBe(4);
      expect(afterRechunkedTail?.pendingChunkReceived).toBe(1);

      // And it is not a dead end: chunk 0 of the NEW chunking re-stages the
      // marker at the new total, after which its own tail commits.
      await apply(context, {
        eventIds: ["a0", "a1"],
        chunk: { index: 0, total: 2 },
        dataRevision: REVISION_A,
      });
      const tailAck = await apply(context, {
        eventIds: ["a2", "a3"],
        chunk: { index: 1, total: 2 },
        dataRevision: REVISION_A,
      });
      expect(tailAck).toEqual([EXTERNAL_SESSION_ID]);

      const afterRepair = await readState(context);
      expect(afterRepair?.eventIds).toEqual(["a0", "a1", "a2", "a3"]);
      expect(afterRepair?.dataRevision).toBe(REVISION_A);
      expect(afterRepair?.pendingChunkRevision).toBeNull();
      expect(afterRepair?.pendingChunkTotal).toBeNull();
      expect(afterRepair?.pendingChunkReceived).toBeNull();
    });
  });

  it("commits an unchunked whole session directly and never stages a marker", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const context = await setup();

      await apply(context, {
        eventIds: ["e0", "e1", "e2"],
        chunk: { index: 0, total: 1 },
        dataRevision: REVISION_A,
      });

      const persisted = await readState(context);
      expect(persisted?.eventIds).toEqual(["e0", "e1", "e2"]);
      expect(persisted?.dataRevision).toBe(REVISION_A);
      expect(persisted?.pendingChunkRevision).toBeNull();
    });
  });

  // ISS-8131 BUG 2, proven by the STORE. The unit test pins the pure gate; these
  // pin the two client shapes the cloud must serve, because the outcome DIFFERS
  // between them and only one of them is reachable by a modern desktop.
  //
  // Before any fix: the sentinel-0 apply nulled all three marker columns, chunks
  // 1..2 came back FOREIGN, and the session held only chunk 0's events at the
  // OLD revision until the desktop re-sent from chunk 0.
  //
  // Now: the marker survives in BOTH shapes, so the sequence always finishes.
  // What differs is whether the stray payload's children land. An echo-capable
  // client is HELD (nothing written, id withheld, re-sent later), so the commit
  // is the staged derivation alone. A pre-#4862 client cannot be held — it reads
  // an omitted id as delivered — so it degrades to the additive apply and still
  // commits a union. That is deliberate: a union is recoverable, whereas acking
  // a payload we refused to write is silent, permanent loss.
  describe("a revision-less payload must not end an assembling sequence (ISS-8131)", () => {
    it("holds the revision-less payload for an echo-capable client, so the sequence commits its OWN derivation alone", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const context = await setup();
        const echo = { wantsAcceptedSessionIds: true };

        await apply(
          context,
          {
            eventIds: ["a0", "a1"],
            chunk: { index: 0, total: 1 },
            dataRevision: REVISION_A,
          },
          echo
        );
        await apply(
          context,
          {
            eventIds: ["b0"],
            chunk: { index: 0, total: 3 },
            dataRevision: REVISION_B,
          },
          echo
        );

        // The same maintenance park as the case below, to the same gate — the
        // ONLY difference is that this client echoes accepted ids, so the hold
        // is expressible.
        const heldAck = await apply(
          context,
          { eventIds: ["a0"], chunk: null, dataRevision: 0 },
          echo
        );
        // HELD: withheld from the echo, so the desktop keeps the row and
        // re-sends under its bounded ack_omitted budget rather than clearing it.
        expect(heldAck).toEqual([]);

        const afterHold = await readState(context);
        expect(afterHold?.pendingChunkRevision).toBe(REVISION_B);
        expect(afterHold?.pendingChunkTotal).toBe(3);
        expect(afterHold?.pendingChunkReceived).toBe(1);
        // Nothing was written: `a0` never reached the row, which is the whole
        // point. The union below is what this prevents.
        expect(afterHold?.eventIds).toEqual(["b0"]);
        expect(afterHold?.dataRevision).toBe(REVISION_A);

        await apply(
          context,
          {
            eventIds: ["b1"],
            chunk: { index: 1, total: 3 },
            dataRevision: REVISION_B,
          },
          echo
        );
        const tailAck = await apply(
          context,
          {
            eventIds: ["b2"],
            chunk: { index: 2, total: 3 },
            dataRevision: REVISION_B,
          },
          echo
        );
        expect(tailAck).toEqual([EXTERNAL_SESSION_ID]);

        const committed = await readState(context);
        expect(committed?.dataRevision).toBe(REVISION_B);
        expect(committed?.pendingChunkRevision).toBeNull();
        expect(committed?.pendingChunkTotal).toBeNull();
        expect(committed?.pendingChunkReceived).toBeNull();
        // The committed rev-B snapshot is EXACTLY the rev-B derivation. No `a0`.
        expect(committed?.eventIds).toEqual(["b0", "b1", "b2"]);
      });
    });

    // davetho (#6271): the case above drives the MAINTENANCE-SENTINEL zero,
    // which `wire-data-revision` folds to "no revision". The ticket is about
    // OMISSION semantics, so the genuinely absent key — an older desktop's wire
    // shape — is driven end to end here rather than inferred from the fold's
    // unit tests. `buildSessionChunk` leaves the key off the object entirely.
    it("holds an OMITTED dataRevision, not just the folded sentinel, and lets the sequence commit clean", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const context = await setup();
        const echo = { wantsAcceptedSessionIds: true };

        await apply(
          context,
          {
            eventIds: ["b0"],
            chunk: { index: 0, total: 2 },
            dataRevision: REVISION_B,
          },
          echo
        );

        const heldAck = await apply(
          context,
          // No `dataRevision` key at all.
          { eventIds: ["a0"], chunk: null, dataRevision: null },
          echo
        );
        expect(heldAck).toEqual([]);

        const afterHold = await readState(context);
        expect(afterHold?.pendingChunkRevision).toBe(REVISION_B);
        expect(afterHold?.pendingChunkReceived).toBe(1);
        expect(afterHold?.eventIds).toEqual(["b0"]);

        const tailAck = await apply(
          context,
          {
            eventIds: ["b1"],
            chunk: { index: 1, total: 2 },
            dataRevision: REVISION_B,
          },
          echo
        );
        expect(tailAck).toEqual([EXTERNAL_SESSION_ID]);

        const committed = await readState(context);
        expect(committed?.dataRevision).toBe(REVISION_B);
        expect(committed?.pendingChunkRevision).toBeNull();
        expect(committed?.eventIds).toEqual(["b0", "b1"]);
      });
    });

    it("cannot hold for a PRE-ECHO client, so its sentinel-0 apply still commits the union — degraded, but never stranded", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const context = await setup();

        // A sealed session at REVISION_A, then chunk 0 of a NEW higher sequence,
        // whose delete-replace drops the rev-A events.
        await apply(context, {
          eventIds: ["a0", "a1"],
          chunk: { index: 0, total: 1 },
          dataRevision: REVISION_A,
        });
        await apply(context, {
          eventIds: ["b0"],
          chunk: { index: 0, total: 3 },
          dataRevision: REVISION_B,
        });

        const staged = await readState(context);
        expect(staged?.eventIds).toEqual(["b0"]);
        expect(staged?.pendingChunkRevision).toBe(REVISION_B);
        expect(staged?.pendingChunkTotal).toBe(3);
        expect(staged?.pendingChunkReceived).toBe(1);

        // The maintenance park: `dataRevision: 0`, unchunked. `wire-data-revision`
        // folds the sentinel to "no revision", which is exactly the BUG-2 input.
        // It carries a DISJOINT event the rev-B derivation dropped, so the
        // additive apply below is visible rather than an upsert onto itself.
        const foldedAck = await apply(context, {
          eventIds: ["a0"],
          chunk: null,
          dataRevision: 0,
        });
        expect(foldedAck).toEqual([EXTERNAL_SESSION_ID]);

        const afterFold = await readState(context);
        // THE FIX: all three marker columns survive.
        expect(afterFold?.pendingChunkRevision).toBe(REVISION_B);
        expect(afterFold?.pendingChunkTotal).toBe(3);
        expect(afterFold?.pendingChunkReceived).toBe(1);
        // The fold is additive and commits no revision of its own.
        expect(afterFold?.dataRevision).toBe(REVISION_A);
        expect(afterFold?.eventIds).toEqual(["a0", "b0"]);

        // The marker survived, so the tail is still in-sequence and completes.
        await apply(context, {
          eventIds: ["b1"],
          chunk: { index: 1, total: 3 },
          dataRevision: REVISION_B,
        });
        const tailAck = await apply(context, {
          eventIds: ["b2"],
          chunk: { index: 2, total: 3 },
          dataRevision: REVISION_B,
        });
        expect(tailAck).toEqual([EXTERNAL_SESSION_ID]);

        const committed = await readState(context);
        expect(committed?.dataRevision).toBe(REVISION_B);
        expect(committed?.pendingChunkRevision).toBeNull();
        expect(committed?.pendingChunkTotal).toBeNull();
        expect(committed?.pendingChunkReceived).toBeNull();
        // The pre-echo fallback, pinned deliberately: this client gets the
        // UNION of the rev-B chunks and the revision-less payload's `a0`, which
        // the rev-B derivation had dropped. The contamination is pre-existing —
        // a revision-less payload has always applied additively (`shouldReplace`
        // is false for it, so `persistSessionChildren` skips the delete) — and
        // the hold above is what removes it for every client that can express
        // one. This arm cannot: omitting the id would read as delivered and the
        // desktop would durably clear a row we never wrote.
        //
        // The population is a compat dead-end, not a live path: chunk-drain
        // detection READS the echo, so a client that chunks at all already
        // sends it. Kept and asserted so the degraded shape is a decision on
        // the record rather than an accident.
        expect(committed?.eventIds).toEqual(["a0", "b0", "b1", "b2"]);
      });
    });
  });
});
