/**
 * @file agent-session-sync-pr-ref-part-marking.test.ts
 * @description ISS-9859 — WHICH parts of a paginated split carry the
 * `prRefsPaginated` marker.
 *
 * The marker is the whole contract with the cloud: a part marked `true` MERGES
 * into the session's stored PR links and `prs` blob, and page 0, marked `false`,
 * REPLACES both. Exactly one PR-list part of a sequence is page 0 — it performs
 * retraction for the whole sequence, and that is what lets pagination work with
 * no cross-request ledger and no commit-time sweep. Mark it `true` and nothing
 * ever retracts; omit its marker and the cloud's freshness-tie rule skips the
 * replace; leave two at `false` and the second wipes the first. A payload that
 * paginates nothing carries no marker key at all.
 *
 * Lives beside `agent-session-sync-pr-ref-chunking.test.ts` (which owns the
 * decision to paginate at all) because this file owns only the marking.
 */
import assert from "node:assert/strict";
import {
  type SessionPR,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import type { SyncedSessionPrRef } from "@repo/api/src/types/session-artifact-link";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  chunkOversizedSession,
  estimateSessionPayloadBytes,
} from "../src/main/agent-sync/agent-session-sync-payload.js";

/** A cap that fits the session's base but not its whole `prRefs` set. */
function capForcingPrRefPagination(prRefs: SyncedSessionPrRef[]): number {
  return (
    estimateSessionPayloadBytes(buildSession({ prRefs: prRefs.slice(0, 12) })) +
    400
  );
}

function prRefParts(chunks: SyncedAgentSession[]): SyncedAgentSession[] {
  return chunks.filter((chunk) => (chunk.prRefs?.length ?? 0) > 0);
}

/** Split under a server that advertised `agentSessionSyncPrRefChunking`. */
function chunkWithPrRefChunking(
  session: SyncedAgentSession,
  maxBytes: number
): SyncedAgentSession[] {
  return chunkOversizedSession(
    session,
    maxBytes,
    undefined,
    undefined,
    /* activityChunkingSupported */ false,
    undefined,
    /* prRefChunkingSupported */ true
  );
}

describe("ISS-9859: prRefsPaginated marking across a paginated split", () => {
  test("exactly ONE prRef part is page 0 (marked false), and it is the first of them", () => {
    const prRefs = buildPrRefs(150);
    const session = buildSession({ prRefs, events: buildEvents(40) });

    const chunks = chunkWithPrRefChunking(
      session,
      capForcingPrRefPagination(prRefs)
    );

    const pages = prRefParts(chunks);
    assert.ok(pages.length > 1, "the refs really did paginate");
    const unmarked = pages.filter((page) => page.prRefsPaginated !== true);
    assert.equal(
      unmarked.length,
      1,
      "exactly one part replaces; the rest merge onto it"
    );
    assert.equal(
      unmarked[0],
      pages[0],
      "the UNMARKED part is the first prRef part — the merges that follow it in the serial drain land on a set it already replaced"
    );
    assert.equal(
      pages[0].prRefsPaginated,
      false,
      "page 0 says false explicitly; an absent marker loses the cloud's freshness tie"
    );
    for (const page of pages.slice(1)) {
      assert.equal(page.prRefsPaginated, true);
    }
  });

  test("the union of the pages is every ref, in order, with none duplicated", () => {
    const prRefs = buildPrRefs(150);
    const session = buildSession({ prRefs, events: buildEvents(40) });

    const chunks = chunkWithPrRefChunking(
      session,
      capForcingPrRefPagination(prRefs)
    );

    const delivered = prRefParts(chunks).flatMap((page) =>
      (page.prRefs ?? []).map((ref) => ref.prNumber)
    );
    assert.deepEqual(
      delivered,
      prRefs.map((ref) => ref.prNumber),
      "pagination must deliver the whole set — the point of the ticket"
    );
  });

  test("with no prs, parts carrying no ref slice OMIT prRefs entirely rather than sending []", () => {
    // An absent `prRefs` is the cloud's "this payload makes no claim" and the
    // link lane early-returns on it. An explicit `[]` is the opposite — a
    // retraction of every PR — so an unmarked base part sending one would
    // delete the session's links mid-sequence. The one sanctioned `[]`, on a
    // `prs` part, is pinned by the production-shape suite below.
    const prRefs = buildPrRefs(150);
    const session = buildSession({ prRefs, events: buildEvents(40) });

    const chunks = chunkWithPrRefChunking(
      session,
      capForcingPrRefPagination(prRefs)
    );

    for (const chunk of chunks) {
      if ((chunk.prRefs?.length ?? 0) === 0) {
        assert.equal(
          Object.hasOwn(chunk, "prRefs"),
          false,
          "a non-slice part must omit the key, never send an empty array"
        );
      }
    }
  });

  test("with NO events the page-0 part is chunk 0 itself, and is still marked false", () => {
    // The shape where "the events part comes first" stops being true. Nothing
    // precedes the slices, so the first prRef part IS index 0 — it must still be
    // the unmarked one, because the marker is found by scanning rather than by
    // assuming a position.
    const prRefs = buildPrRefs(150);
    const session = buildSession({ prRefs, events: [] });

    const chunks = chunkWithPrRefChunking(
      session,
      capForcingPrRefPagination(prRefs)
    );

    const pages = prRefParts(chunks);
    assert.ok(pages.length > 1, "the refs really did paginate");
    assert.equal(
      chunks[0],
      pages[0],
      "with no events, chunk 0 IS the first page"
    );
    assert.equal(
      chunks[0]?.prRefsPaginated,
      false,
      "chunk 0 replaces here, exactly as the mid-sequence page-0 part does"
    );
  });

  test("a session that FITS keeps prRefs replicated whole and marks nothing", () => {
    // The counterfactual for every case above: without a cap that forces
    // pagination, the marker must never appear, or an ordinary session would
    // start merging instead of replacing.
    const prRefs = buildPrRefs(5);
    const session = buildSession({ prRefs, events: buildEvents(60) });
    const maxBytes =
      estimateSessionPayloadBytes(buildSession({ prRefs, events: [] })) + 1500;

    const chunks = chunkWithPrRefChunking(session, maxBytes);

    assert.ok(chunks.length > 1, "the events force a multi-part split");
    for (const chunk of chunks) {
      assert.equal(
        Object.hasOwn(chunk, "prRefsPaginated"),
        false,
        "a payload that paginates nothing carries no marker key at all"
      );
      assert.deepEqual(
        chunk.prRefs?.map((ref) => ref.prNumber),
        prRefs.map((ref) => ref.prNumber),
        "every part carries the whole set, as before this ticket"
      );
    }
  });
});

describe("ISS-9859: marking when both PR lists paginate (production shape)", () => {
  // The producer emits `prs` alongside `prRefs`, both uncapped, so a session
  // with enough PRs to page its refs pages its `prs` blob as well.
  const prRefs = buildPrRefs(150);
  const prs = buildPrs(150);
  const session = buildSession({ prRefs, prs, events: buildEvents(40) });

  test("page 0 is the first PR-list part, marked false, and carries prRefs; every later one is marked true", () => {
    const chunks = chunkWithPrRefChunking(
      session,
      capForcingPrRefPagination(prRefs)
    );

    const pages = prListParts(chunks);
    assert.ok(pages.length > 1, "the PR lists really did paginate");
    const [pageZero, ...continuations] = pages;
    assert.equal(
      pageZero.prRefsPaginated,
      false,
      "page 0 says false explicitly, so the cloud admits its replace at a tie"
    );
    assert.ok(
      Object.hasOwn(pageZero, "prRefs"),
      "page 0 states prRefs, so its Replace retracts stale links"
    );
    for (const page of continuations) {
      assert.equal(page.prRefsPaginated, true, "every later part merges");
    }
    for (const chunk of chunks) {
      if (!pages.includes(chunk)) {
        assert.equal(
          Object.hasOwn(chunk, "prRefsPaginated"),
          false,
          "a base part carries no marker"
        );
      }
    }
  });

  test("a ref part omits prs, and a prs part states prRefs: []", () => {
    const chunks = chunkWithPrRefChunking(
      session,
      capForcingPrRefPagination(prRefs)
    );

    const pages = prListParts(chunks);
    const refParts = pages.filter((page) => (page.prRefs?.length ?? 0) > 0);
    const prsParts = pages.filter((page) => (page.prs?.length ?? 0) > 0);
    assert.ok(refParts.length > 0 && prsParts.length > 0, "both lists paged");
    for (const page of pages) {
      if ((page.prs?.length ?? 0) === 0) {
        assert.equal(
          Object.hasOwn(page, "prs"),
          false,
          "no prs slice means no prs key — `[]` on page 0 would clear the blob"
        );
      }
      if ((page.prRefs?.length ?? 0) === 0) {
        assert.deepEqual(
          page.prRefs,
          [],
          "a part with no ref slice still states prRefs, because the session did"
        );
      }
    }
    assert.deepEqual(
      prsParts.flatMap((page) => (page.prs ?? []).map((pr) => pr.num)),
      prs.map((pr) => pr.num),
      "the union of the prs slices is the whole blob"
    );
  });
});

/** The parts carrying either PR list. */
function prListParts(chunks: SyncedAgentSession[]): SyncedAgentSession[] {
  return chunks.filter(
    (chunk) => Object.hasOwn(chunk, "prRefs") || Object.hasOwn(chunk, "prs")
  );
}

function buildPrs(count: number): SessionPR[] {
  return Array.from({ length: count }, (_, index) => ({
    num: index + 1,
    title: `Refactor the sync lane, part ${index + 1}`,
    status: SessionPrLifecycleStatus.Open,
  }));
}

function buildSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "sess-pr-ref-marking",
    name: "PR-heavy session",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/wt",
    model: "claude-opus-4",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function buildPrRefs(count: number): SyncedSessionPrRef[] {
  return Array.from({ length: count }, (_, index) => ({
    repositoryFullName: "acme/web",
    prNumber: index + 1,
    relationType: SessionPrRelationType.Created,
  }));
}

function buildEvents(count: number): SyncedAgentSession["events"] {
  return Array.from({ length: count }, (_, index) => ({
    externalEventId: `evt-${String(index).padStart(4, "0")}`,
    eventType: "ToolUse",
    toolName: "Read",
    createdAt: "2026-06-10T10:30:00.000Z",
  }));
}
