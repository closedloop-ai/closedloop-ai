/**
 * ISS-9859: the `pullRequests` blob for the parts of a paginated PR sequence,
 * plus the per-lane write flags and the freshness gate those parts go through.
 *
 * The whole-set rules (ISS-4768 / ISS-4946) are pinned in
 * `persist-pull-requests-blob.test.ts`. This file pins what changes when a part
 * carries one page. Every case drives `toTraceDetailPatch`, the function the
 * ingest calls, rather than the resolver behind it.
 */
import {
  MAX_SESSION_SYNC_CHUNKS,
  type SessionPR,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import {
  SessionPrRelationType,
  type SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import { resolveSessionFreshnessGates } from "./field-regression-guards";
import {
  resolveSessionPullRequestEvidence,
  toTraceDetailPatch,
} from "./persist-session-children";
import { resolveCreateArmDetail } from "./upsert-arm-detail";

const REPO = "closedloop-ai/closedloop-ai";
const PR_A: SessionPR = { num: 1, title: "PR #1", status: "open" };
const PR_B: SessionPR = { num: 2, title: "PR #2", status: "open" };
const PR_C: SessionPR = { num: 3, title: "PR #3", status: "merged" };
const CONTINUATION_CHUNK = { index: 1, total: 3 };

describe("continuation part: appends its page to the stored blob", () => {
  it("keeps the stored entries in stored order and adds the page after them", () => {
    const patch = blobPatch(continuation({ prs: [PR_C] }), [PR_A, PR_B]);

    expect(patch.pullRequests).toEqual([PR_A, PR_B, PR_C]);
  });

  it("adds no entry the stored blob already holds", () => {
    const patch = blobPatch(continuation({ prs: [PR_B, PR_C] }), [PR_A, PR_B]);

    expect(patch.pullRequests).toEqual([PR_A, PR_B, PR_C]);
  });

  it("writes the same blob when the same page is delivered again", () => {
    const page = continuation({ prs: [PR_B, PR_C] });
    const first = blobPatch(page, [PR_A]).pullRequests;
    const second = blobPatch(page, first as Prisma.JsonValue).pullRequests;

    expect(second).toEqual([PR_A, PR_B, PR_C]);
    expect(second).toEqual(first);
  });

  it("treats an entry as present only when num, title and status all match", () => {
    const renamed = { ...PR_A, title: "PR #1 renamed" };
    const merged = { ...PR_A, status: "merged" };
    const stringNumber = { ...PR_A, num: "1" };

    const patch = blobPatch(
      continuation({ prs: [renamed, merged, stringNumber] }),
      [PR_A]
    );

    expect(patch.pullRequests).toEqual([PR_A, renamed, merged, stringNumber]);
  });

  it("adds a repeated page entry once", () => {
    const patch = blobPatch(continuation({ prs: [PR_B, PR_B] }), [PR_A]);

    expect(patch.pullRequests).toEqual([PR_A, PR_B]);
  });

  it("writes the page alone when the row holds no blob", () => {
    const patch = blobPatch(continuation({ prs: [PR_B] }), null);

    expect(patch.pullRequests).toEqual([PR_B]);
  });

  it("carries forward only stored entries the read path can parse", () => {
    const patch = blobPatch(continuation({ prs: [PR_C] }), [PR_A, { num: 2 }]);

    expect(patch.pullRequests).toEqual([PR_A, PR_C]);
  });

  it("treats a stored value that is not an array as no blob", () => {
    const patch = blobPatch(continuation({ prs: [PR_C] }), "not-a-list");

    expect(patch.pullRequests).toEqual([PR_C]);
  });
});

describe("continuation part: never clears the blob", () => {
  // The whole-set rule reads `prRefs` with no `prs` as "recalculated to empty"
  // and CLEARS. A continuation part whose page held only links is the same
  // shape and must not wipe the pages before it.
  it("preserves the blob when prs is omitted and prRefs is present", () => {
    const patch = blobPatch(continuation({ prRefs: [prRef(2)] }), [PR_A]);

    expect(Object.hasOwn(patch, "pullRequests")).toBe(false);
  });

  it("preserves the blob when prs is omitted and prRefs is empty", () => {
    const patch = blobPatch(continuation({ prRefs: [] }), [PR_A]);

    expect(Object.hasOwn(patch, "pullRequests")).toBe(false);
  });

  it.each([
    { label: "empty", prs: [] },
    { label: "null", prs: null },
  ])("preserves the blob when the page is $label", ({ prs }) => {
    const patch = blobPatch(continuation({ prs, prRefs: [] }), [PR_A]);

    expect(Object.hasOwn(patch, "pullRequests")).toBe(false);
  });

  it("preserves the blob when the caller did not read the stored blob", () => {
    // Fails toward keeping the earlier pages: writing the page alone would
    // drop every one of them.
    const patch = toTraceDetailPatch(continuation({ prs: [PR_B] }), {
      includePullRequests: true,
    });

    expect(Object.hasOwn(patch, "pullRequests")).toBe(false);
  });
});

describe("a part that is not a continuation keeps whole-set semantics", () => {
  const WHOLE_SET_SHAPES = [
    {
      label: "page 0 (an explicit false marker), mid-sequence",
      prRefsPaginated: false,
      chunk: CONTINUATION_CHUNK,
    },
    {
      label: "a part with no marker, mid-sequence",
      prRefsPaginated: undefined,
      chunk: CONTINUATION_CHUNK,
    },
    {
      label: "a marked chunk 0",
      prRefsPaginated: true,
      chunk: { index: 0, total: 3 },
    },
    { label: "a marked unchunked payload", prRefsPaginated: true, chunk: null },
    {
      label: "a marked part past the chunk ceiling",
      prRefsPaginated: true,
      chunk: { index: 1, total: MAX_SESSION_SYNC_CHUNKS + 1 },
    },
    {
      label: "a marked part whose index is not below its total",
      prRefsPaginated: true,
      chunk: { index: 3, total: 3 },
    },
  ];

  it.each(WHOLE_SET_SHAPES)(
    "$label replaces the blob with its prs",
    (shape) => {
      const patch = blobPatch(
        part({
          prRefsPaginated: shape.prRefsPaginated,
          chunk: shape.chunk,
          prs: [PR_B],
        }),
        [PR_A]
      );

      expect(patch.pullRequests).toEqual([PR_B]);
    }
  );

  it.each(WHOLE_SET_SHAPES)(
    "$label clears the blob when prs is omitted and prRefs is present",
    (shape) => {
      const patch = blobPatch(
        part({
          prRefsPaginated: shape.prRefsPaginated,
          chunk: shape.chunk,
          prRefs: [prRef(2)],
        }),
        [PR_A]
      );

      expect(patch.pullRequests).toBe(Prisma.DbNull);
    }
  );
});

describe("per-lane write flags on a continuation part", () => {
  it("reports no blob write when the part carries no prs page", () => {
    const evidence = resolveSessionPullRequestEvidence(
      continuation({ prRefs: [prRef(2)] })
    );

    expect(evidence.hasBlobWrite).toBe(false);
  });

  it("reports a blob write when the part carries a prs page", () => {
    const evidence = resolveSessionPullRequestEvidence(
      continuation({ prs: [PR_B] })
    );

    expect(evidence.hasBlobWrite).toBe(true);
  });

  it("reports no link write for an empty prRefs page, and one for a non-empty page", () => {
    expect(
      resolveSessionPullRequestEvidence(continuation({ prRefs: [] }))
        .hasLinkWrite
    ).toBe(false);
    expect(
      resolveSessionPullRequestEvidence(continuation({ prRefs: [prRef(2)] }))
        .hasLinkWrite
    ).toBe(true);
  });
});

/**
 * Every part of one sequence carries the session's one `updatedAt`, and the
 * first part to land stores it, so each later part meets the PR gate at a TIE.
 * There only a lane with evidence of its own may write.
 */
describe("the PR freshness gate at a sequence's shared updatedAt", () => {
  it("admits a continuation part's prs page on the terms its prRefs page gets", () => {
    const gates = gatesAtTie(continuation({ prs: [PR_B], prRefs: [prRef(2)] }));

    expect(gates.shouldUpdatePullRequestsBlob).toBe(true);
    expect(gates.shouldUpdatePullRequestLinks).toBe(true);
  });

  it("admits a prs page that arrives with an empty prRefs page", () => {
    const gates = gatesAtTie(continuation({ prs: [PR_B], prRefs: [] }));

    expect(gates.shouldUpdatePullRequestsBlob).toBe(true);
    expect(gates.shouldUpdatePullRequestLinks).toBe(false);
  });

  it("skips a continuation part with nothing to add, and reports no loss", () => {
    const gates = gatesAtTie(continuation({ prRefs: [] }));

    expect(gates.shouldUpdatePullRequestsBlob).toBe(false);
    expect(gates.shouldUpdatePullRequestLinks).toBe(false);
    expect(gates.didPreservePullRequestsOnTie).toBe(false);
  });

  it("still reports the loss for a whole-set payload with nothing in it", () => {
    // Control: the ISS-4946 counter is unchanged for the shape it was built for.
    const gates = gatesAtTie(part({ prRefs: [] }));

    expect(gates.didPreservePullRequestsOnTie).toBe(true);
  });
});

/**
 * Page 0 (`prRefsPaginated: false`) ties the base parts of its own sequence,
 * so its whole-set replace lands only because the tie admits it. Every other
 * tie stays under the ISS-4946 rule.
 */
describe("page 0 of a paginated PR list at the tie", () => {
  it("admits the blob CLEAR with no blob evidence, and reports no loss", () => {
    const session = pageZero({ prRefs: [prRef(1)] });
    const gates = gatesAtTie(session);

    expect(gates.shouldUpdatePullRequestsBlob).toBe(true);
    expect(blobPatch(session, [PR_A, PR_B]).pullRequests).toBe(Prisma.DbNull);
    expect(gates.didPreservePullRequestsOnTie).toBe(false);
  });

  it("admits an empty link replace, and reports no loss", () => {
    const gates = gatesAtTie(pageZero({ prRefs: [] }));

    expect(gates.shouldUpdatePullRequestLinks).toBe(true);
    expect(gates.shouldUpdatePullRequestsBlob).toBe(true);
    expect(gates.didPreservePullRequestsOnTie).toBe(false);
  });

  it("replaces the blob with page 0's own prs", () => {
    const session = pageZero({ prs: [PR_B] });

    expect(gatesAtTie(session).shouldUpdatePullRequestsBlob).toBe(true);
    expect(blobPatch(session, [PR_A]).pullRequests).toEqual([PR_B]);
  });

  it("does not admit a STALE page 0", () => {
    const gates = gatesAgainstStored(
      pageZero({ prRefs: [] }),
      new Date("2026-08-02T12:00:00.000Z")
    );

    expect(gates.shouldUpdatePullRequestsBlob).toBe(false);
    expect(gates.shouldUpdatePullRequestLinks).toBe(false);
  });

  it.each([
    { label: "carries no marker", marker: {} },
    {
      label: "carries the marker with no chunk",
      marker: { prRefsPaginated: false, chunk: null },
    },
    {
      label: "carries the marker past the chunk ceiling",
      marker: {
        prRefsPaginated: false,
        chunk: { index: 1, total: MAX_SESSION_SYNC_CHUNKS + 1 },
      },
    },
  ])("keeps the ISS-4946 preserve for a part that $label", ({ marker }) => {
    const gates = gatesAtTie(part({ ...marker, prRefs: [] }));

    expect(gates.shouldUpdatePullRequestsBlob).toBe(false);
    expect(gates.shouldUpdatePullRequestLinks).toBe(false);
    expect(gates.didPreservePullRequestsOnTie).toBe(true);
  });
});

describe("the create arm of the ingest upsert", () => {
  it("writes a continuation part's page alone, because the new row has no blob", () => {
    // The create arm runs when the stored row was swept between the ingest's
    // read and its upsert. Appending to that row's blob would carry a deleted
    // row's list onto a brand-new artifact.
    const detail = resolveCreateArmDetail({
      incomingRevision: 7,
      incomingStatus: SESSION_STATUS.ACTIVE,
      rowLevelAck: false,
      incomingMetadata: null,
      persistedAgents: [],
      session: continuation({ prs: [PR_B] }),
      shouldReplace: false,
    });

    expect(detail.pullRequests).toEqual([PR_B]);
  });
});

function part(extras: Partial<SyncedAgentSession> = {}): SyncedAgentSession {
  return {
    externalSessionId: "sess-blob-page-1",
    status: "active",
    startedAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-02T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...extras,
  };
}

function continuation(
  extras: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return part({
    prRefsPaginated: true,
    chunk: CONTINUATION_CHUNK,
    ...extras,
  });
}

function prRef(prNumber: number): SyncedSessionPrRef {
  return {
    prNumber,
    relationType: SessionPrRelationType.Created,
    repositoryFullName: REPO,
  };
}

function blobPatch(
  session: SyncedAgentSession,
  storedPullRequests: Prisma.JsonValue
) {
  return toTraceDetailPatch(session, {
    includePullRequests: true,
    storedPullRequests,
  });
}

/** Page 0 of a paginated PR list, mid-sequence behind a base part. */
function pageZero(
  extras: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return part({
    prRefsPaginated: false,
    chunk: CONTINUATION_CHUNK,
    ...extras,
  });
}

function gatesAtTie(session: SyncedAgentSession) {
  return gatesAgainstStored(session, new Date(session.updatedAt));
}

/** Mirrors the ingest's gate call: the evidence feeds the gate whole. */
function gatesAgainstStored(
  session: SyncedAgentSession,
  storedUpdatedAt: Date
) {
  const evidence = resolveSessionPullRequestEvidence(session);
  const updatedAt = new Date(session.updatedAt);
  return resolveSessionFreshnessGates({
    existingSessionUpdatedAt: storedUpdatedAt,
    incomingSessionUpdatedAt: updatedAt,
    receivedAt: updatedAt,
    hasPullRequestBlobEvidence: evidence.hasBlobEvidence,
    hasPullRequestLinkEvidence: evidence.hasLinkEvidence,
    hasPullRequestBlobWrite: evidence.hasBlobWrite,
    hasPullRequestLinkWrite: evidence.hasLinkWrite,
    isPullRequestListPageZero: evidence.isPrListPageZero,
  });
}
