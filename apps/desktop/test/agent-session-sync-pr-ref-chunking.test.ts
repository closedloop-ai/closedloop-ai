/**
 * @file agent-session-sync-pr-ref-chunking.test.ts
 * @description ISS-9859 — a session's PR references reach the cloud in full.
 * The two PR lists, `prRefs` then the legacy `prs` blob, are the chunker's
 * paginated PR streams, gated on the server's `agentSessionSyncPrRefChunking`
 * capability and used only when the ordinary split (every part replicating both
 * whole lists) would dead-letter.
 */
import assert from "node:assert/strict";
import {
  AgentSessionSyncMode,
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
  prepareAgentSessionPayload,
} from "../src/main/agent-sync/agent-session-sync-payload.js";
import { resolvePendingChunkTransition } from "../src/main/agent-sync/agent-session-sync-pending-chunks.js";

describe("ISS-9859: a pinned prRef-paginated tail on capability downgrade", () => {
  test("is DISCARDED when the server no longer merges marked parts", () => {
    // A tail whose parts are marked `prRefsPaginated` only means "merge" to a
    // server that advertised the capability. Shipping it to one that did not
    // makes that server REPLACE the session's PR links with a single slice —
    // the precise loss this ticket removes. So the tail is dropped and the
    // session re-chunks whole, exactly as the ISS-4541 tiling tail does.
    const transition = resolvePendingChunkTransition(
      {
        sessionId: "sess-pr-ref-downgrade",
        syncMode: AgentSessionSyncMode.Backfill,
        chunks: [buildSession({ prRefs: buildPrRefs(3) })],
        compress: false,
        activityChunked: false,
        prRefChunked: true,
      },
      /* compressionSupported */ true,
      /* activityChunkingSupported */ true,
      /* monitoredActivitySupported */ true,
      /* currentDataSyncLevel */ undefined,
      /* maxBatchBytes */ undefined,
      /* prRefChunkingSupported */ false
    );

    assert.deepEqual(transition, {
      kind: "discard-downgrade",
      sessionId: "sess-pr-ref-downgrade",
      chunkCount: 1,
    });
  });

  test("is KEPT when the capability still holds", () => {
    // The counterfactual: without it, a discard that fired unconditionally
    // would pass the case above and silently stall every paginated drain.
    const transition = resolvePendingChunkTransition(
      {
        sessionId: "sess-pr-ref-downgrade",
        syncMode: AgentSessionSyncMode.Backfill,
        chunks: [buildSession({ prRefs: buildPrRefs(3) })],
        compress: false,
        activityChunked: false,
        prRefChunked: true,
      },
      true,
      true,
      true,
      undefined,
      undefined,
      /* prRefChunkingSupported */ true
    );

    assert.equal(transition.kind, "send");
  });
});

describe("ISS-9859 lock: a split that fits keeps prRefs replicated whole", () => {
  test("every part of an events-driven split carries the full prRefs and prs", () => {
    const prRefs = buildPrRefs(5);
    const session = buildSession({
      prRefs,
      prs: prRefs.map((ref) => ({
        num: ref.prNumber,
        title: `PR ${ref.prNumber}`,
        status: "open",
      })),
      events: buildEvents(60),
    });
    const maxBytes =
      estimateSessionPayloadBytes(buildSession({ prRefs, events: [] })) + 1500;

    const chunks = chunkOversizedSession(session, maxBytes);

    assert.ok(chunks.length > 1, "the events force a multi-part split");
    for (const chunk of chunks) {
      assert.deepEqual(
        chunk.prRefs?.map((ref) => ref.prNumber),
        prRefs.map((ref) => ref.prNumber),
        "each part carries the whole prRefs set, as today"
      );
      assert.equal(chunk.prs?.length, prRefs.length);
      assert.equal(Object.hasOwn(chunk, "prRefsPaginated"), false);
    }
  });

  test("prRefs that overflow the replicated base refuse to split (dead-letter), never a partial set", () => {
    const prRefs = buildPrRefs(150);
    const session = buildSession({ prRefs, events: buildEvents(10) });
    const maxBytes =
      estimateSessionPayloadBytes(
        buildSession({ prRefs: prRefs.slice(0, 20) })
      ) + 500;

    assert.deepEqual(chunkOversizedSession(session, maxBytes), []);
  });

  test("a whole-session payload carries no prRefsPaginated key, even under the capability", () => {
    const session = buildSession({
      prRefs: buildPrRefs(5),
      prs: buildPrs(5),
      events: buildEvents(3),
    });

    const prepared = prepareAgentSessionPayload(
      session,
      WHOLE_SESSION_CAP_BYTES,
      undefined,
      undefined,
      /* activityChunkingSupported */ false,
      undefined,
      /* prRefChunkingSupported */ true
    );

    if (prepared.kind !== "session") {
      assert.fail(`expected a whole session, got ${prepared.kind}`);
    }
    assert.equal(
      Object.hasOwn(prepared.session, "prRefsPaginated"),
      false,
      "only a paginated split may speak the marker"
    );
  });
});

describe("ISS-9859: a prs blob too large to replicate pages with the refs", () => {
  test("a session whose prs alone overflow a part ships every PR once instead of dead-lettering", () => {
    // The refs here fit a part on their own. Only the uncapped `prs` blob is
    // too large to replicate, which is the shape that used to dead-letter the
    // whole session even though the capability was negotiated.
    const prRefs = buildPrRefs(5);
    const prs = buildPrs(PROLIFIC_PR_COUNT);
    const events = buildEvents(40);
    const session = buildSession({ prRefs, prs, events });
    const maxBytes = capForcingPrsPagination();

    const chunks = chunkWithPrRefChunking(session, maxBytes);

    assert.ok(
      chunks.length > 0,
      "a negotiated capability must not dead-letter"
    );
    assert.deepEqual(
      chunks.flatMap((chunk) => (chunk.prs ?? []).map((pr) => pr.num)),
      prs.map((pr) => pr.num),
      "every prs entry arrives exactly once, in order"
    );
    assert.deepEqual(
      chunks.flatMap((chunk) =>
        (chunk.prRefs ?? []).map((ref) => ref.prNumber)
      ),
      prRefs.map((ref) => ref.prNumber),
      "every prRefs entry arrives exactly once, in order"
    );
    assert.deepEqual(
      chunks.flatMap((chunk) => chunk.events.map((e) => e.externalEventId)),
      events.map((event) => event.externalEventId),
      "the events the dead-letter used to discard arrive too"
    );
    for (const chunk of chunks) {
      assert.ok(
        estimateSessionPayloadBytes(chunk) <= maxBytes,
        `chunk ${chunk.chunk?.index} is within the per-part cap`
      );
    }
    const eventParts = chunks.filter((chunk) => chunk.events.length > 0);
    assert.ok(eventParts.length > 0, "the split has replicated-base parts");
    for (const part of eventParts) {
      assert.equal(Object.hasOwn(part, "prRefs"), false);
      assert.equal(
        Object.hasOwn(part, "prs"),
        false,
        "the replicated base carries neither PR list, so no part repeats them"
      );
    }
  });

  test("an empty prRefs with a huge prs still paginates, and page 0 carries prRefs: []", () => {
    // `prRefs: []` is a real claim — the session retracted every link — so the
    // Replace on page 0 must still state it, or the stale links survive.
    const prs = buildPrs(PROLIFIC_PR_COUNT);
    const session = buildSession({ prRefs: [], prs, events: buildEvents(40) });

    const chunks = chunkWithPrRefChunking(session, capForcingPrsPagination());

    const pages = prListParts(chunks);
    assert.ok(pages.length > 1, "the prs really did paginate");
    const [pageZero, ...continuations] = pages;
    assert.equal(
      pageZero.prRefsPaginated,
      false,
      "page 0 says false explicitly, so the cloud admits its replace at a tie"
    );
    assert.deepEqual(pageZero.prRefs, []);
    assert.ok((pageZero.prs?.length ?? 0) > 0, "page 0 carries its prs slice");
    for (const page of continuations) {
      assert.equal(page.prRefsPaginated, true);
      assert.deepEqual(page.prRefs, [], "a later part merges nothing");
    }
    assert.deepEqual(
      pages.flatMap((page) => (page.prs ?? []).map((pr) => pr.num)),
      prs.map((pr) => pr.num)
    );
  });

  test("a session that never declared prRefs gets no invented prRefs key", () => {
    const prs = buildPrs(PROLIFIC_PR_COUNT);
    const session = buildSession({ prs, events: buildEvents(40) });

    const chunks = chunkWithPrRefChunking(session, capForcingPrsPagination());

    assert.ok(prListParts(chunks).length > 1, "the prs really did paginate");
    for (const chunk of chunks) {
      assert.equal(
        Object.hasOwn(chunk, "prRefs"),
        false,
        "an absent prRefs leaves the links untouched; a `[]` would delete them"
      );
    }
    assert.deepEqual(
      chunks.flatMap((chunk) => (chunk.prs ?? []).map((pr) => pr.num)),
      prs.map((pr) => pr.num)
    );
  });

  test("without the capability the same session still dead-letters whole", () => {
    const session = buildSession({
      prRefs: buildPrRefs(5),
      prs: buildPrs(PROLIFIC_PR_COUNT),
      events: buildEvents(40),
    });
    const maxBytes = capForcingPrsPagination();

    assert.deepEqual(chunkOversizedSession(session, maxBytes), []);
    assert.equal(
      prepareAgentSessionPayload(session, maxBytes).kind,
      "dead-letter"
    );
  });

  test("prepare ships that session chunked once the capability is negotiated", () => {
    const session = buildSession({
      prRefs: buildPrRefs(5),
      prs: buildPrs(PROLIFIC_PR_COUNT),
      events: buildEvents(40),
    });

    const prepared = prepareAgentSessionPayload(
      session,
      capForcingPrsPagination(),
      undefined,
      undefined,
      /* activityChunkingSupported */ false,
      undefined,
      /* prRefChunkingSupported */ true
    );

    assert.equal(prepared.kind, "chunked");
  });
});

/** Enough PRs that the `prs` blob cannot ride any part whole. */
const PROLIFIC_PR_COUNT = 400;

/** The production content cap's order of magnitude; a small session fits it. */
const WHOLE_SESSION_CAP_BYTES = 256 * 1024;

function buildSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "sess-pr-refs",
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

function buildPrs(count: number): SessionPR[] {
  return Array.from({ length: count }, (_, index) => ({
    num: index + 1,
    title: `Refactor the sync lane, part ${index + 1}`,
    status: SessionPrLifecycleStatus.Open,
  }));
}

/** A cap that fits the base, five refs and a few events, but not 400 prs. */
function capForcingPrsPagination(): number {
  return (
    estimateSessionPayloadBytes(
      buildSession({ prRefs: buildPrRefs(5), prs: buildPrs(20) })
    ) + 400
  );
}

/** The parts carrying either PR list. */
function prListParts(chunks: SyncedAgentSession[]): SyncedAgentSession[] {
  return chunks.filter(
    (chunk) => Object.hasOwn(chunk, "prRefs") || Object.hasOwn(chunk, "prs")
  );
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
