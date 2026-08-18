/**
 * ISS-4768 (wongk review): the legacy `pullRequests` blob's omit-vs-clear
 * semantics at the sync write boundary.
 *
 * The desktop producer emits `prs` CONDITIONALLY (`...(prs.length > 0 ? { prs } :
 * {})` in `apps/desktop/src/main/database/session-trace.ts`), so an omitted `prs`
 * means one of two very different things. A pre-link-extraction build never sends
 * it at all and its stored blob must be preserved. A CURRENT build whose PR set
 * recalculated to empty also omits it — and that snapshot's `prRefs: []` deletes
 * the session→PR links, so preserving the blob left the row as stale-blob-plus-
 * zero-links, exactly the shape the read boundary's authoring gate keeps because
 * "no link adjudicates this PR". The retracted phantom would outlive the sync that
 * retracted it.
 *
 * `prRefs` is the discriminator: every link-extracting build emits it
 * unconditionally, and the chunked-sync builders replicate the whole session into
 * each chunk, so `prRefs`-without-`prs` can only mean "recalculated to empty".
 */
import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import {
  SessionPrRelationType,
  type SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  resolveSessionPullRequestEvidence,
  toTraceDetailPatch,
} from "./persist-session-children";

const REPO = "closedloop-ai/symphony-alpha";

function baseSession(
  extras: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "sess-blob-1",
    status: "active",
    startedAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-02T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...extras,
  };
}

function prRef(prNumber: number): SyncedSessionPrRef {
  return {
    prNumber,
    relationType: SessionPrRelationType.Created,
    repositoryFullName: REPO,
  };
}

describe("toTraceDetailPatch — legacy pullRequests blob (ISS-4768)", () => {
  it("writes the payload's own PR list unchanged", () => {
    const patch = toTraceDetailPatch(
      baseSession({
        prs: [{ num: 7, title: "PR #7", status: "merged" }],
        prRefs: [prRef(7)],
      }),
      { includePullRequests: true }
    );

    expect(patch.pullRequests).toEqual([
      { num: 7, title: "PR #7", status: "merged" },
    ]);
  });

  // The bug this test exists for: a current snapshot that recalculated to empty
  // must CLEAR the stored blob, not silently preserve it. Without the fix the
  // patch omits `pullRequests` entirely and the stale PR renders forever.
  it("clears the blob when a link-extracting build recalculated its PR set to empty", () => {
    const patch = toTraceDetailPatch(baseSession({ prRefs: [] }), {
      includePullRequests: true,
    });

    expect(Object.hasOwn(patch, "pullRequests")).toBe(true);
    expect(patch.pullRequests).toBe(Prisma.DbNull);
  });

  // A non-empty `prRefs` with an omitted `prs` is the same generation signal —
  // the producer ran and its legacy list came out empty (every ref resolved to a
  // repo-scoped link rather than a blob row).
  it("clears the blob when prRefs are present but the legacy list is empty", () => {
    const patch = toTraceDetailPatch(baseSession({ prRefs: [prRef(4246)] }), {
      includePullRequests: true,
    });

    expect(patch.pullRequests).toBe(Prisma.DbNull);
  });

  // Compatibility Guardrail: a build that predates session→PR link extraction
  // sends NEITHER field. Its stored blob is the only PR source it has, so the
  // patch must leave the column untouched.
  it("preserves the blob for a pre-link-extraction build that sends neither field", () => {
    const patch = toTraceDetailPatch(baseSession(), {
      includePullRequests: true,
    });

    expect(Object.hasOwn(patch, "pullRequests")).toBe(false);
  });

  // An explicit empty list already lands as an empty JSON array (an intentional
  // clear of the rendered set, distinct from the `DbNull` above) and must stay
  // one — the new branch must not change how a payload that DOES send `prs: []`
  // is written.
  it("still writes an explicitly empty prs list as an empty array", () => {
    const patch = toTraceDetailPatch(baseSession({ prs: [], prRefs: [] }), {
      includePullRequests: true,
    });

    expect(patch.pullRequests).toEqual([]);
  });
});

/**
 * ISS-4946: desktop sync is at-least-once and can reorder or redeliver, so the
 * CLEAR branch above needs the same `updatedAt >= sessionUpdatedAt` freshness
 * watermark every other regression-guarded column on this upsert carries. A late
 * older batch — captured with `prRefs: []` before the PR existed — otherwise
 * lands after the newer batch that populated the blob and wipes it, permanently
 * for an ended session that never resyncs.
 */
describe("toTraceDetailPatch — pullRequests freshness gate (ISS-4946)", () => {
  it("skips the destructive clear when the batch is stale", () => {
    const patch = toTraceDetailPatch(baseSession({ prRefs: [] }), {
      includePullRequests: false,
    });

    expect(Object.hasOwn(patch, "pullRequests")).toBe(false);
  });

  it("skips a stale batch's own PR list so it cannot overwrite a newer one", () => {
    const patch = toTraceDetailPatch(
      baseSession({
        prs: [{ num: 7, title: "PR #7", status: "merged" }],
        prRefs: [prRef(7)],
      }),
      { includePullRequests: false }
    );

    expect(Object.hasOwn(patch, "pullRequests")).toBe(false);
  });

  it("writes the blob when the batch is at least as fresh as the stored row", () => {
    const patch = toTraceDetailPatch(baseSession({ prRefs: [] }), {
      includePullRequests: true,
    });

    expect(patch.pullRequests).toBe(Prisma.DbNull);
  });

  // ISS-4946 review: the gate is truthy — it matches `includeEndsWithError`, not
  // `includeTraceDurations`. A call site that forgets the option must fall back
  // to PRESERVING the stored blob; defaulting the other way would silently hand
  // a new caller the unconditional destructive clear this guard removed.
  it("preserves the blob when a caller omits the gate entirely", () => {
    const patch = toTraceDetailPatch(baseSession({ prRefs: [] }));

    expect(Object.hasOwn(patch, "pullRequests")).toBe(false);
  });

  it("preserves the blob when a caller passes no options at all", () => {
    const patch = toTraceDetailPatch(
      baseSession({
        prs: [{ num: 7, title: "PR #7", status: "merged" }],
        prRefs: [prRef(7)],
      }),
      {}
    );

    expect(Object.hasOwn(patch, "pullRequests")).toBe(false);
  });
});

/**
 * ISS-4946 (review, #4327): the per-lane facts the equal-watermark tie-break
 * consumes. Evidence decides who may WRITE at a tie; the write-pending flags
 * decide whether a skip actually cost anything, and therefore whether the tie
 * belongs in the `PrStatePreservedOnTie` counter.
 */
describe("resolveSessionPullRequestEvidence (ISS-4946)", () => {
  it("reports no write for a pre-link-extraction build that sends neither shape", () => {
    const evidence = resolveSessionPullRequestEvidence(baseSession());

    expect(evidence.hasBlobEvidence).toBe(false);
    expect(evidence.hasLinkEvidence).toBe(false);
    // Nothing to suppress: the blob patch resolves to `undefined` (no column in
    // the patch) and `persistSessionPrArtifactLinks` early-returns on an
    // undefined ref list, so a tie here loses nothing.
    expect(evidence.hasBlobWrite).toBe(false);
    expect(evidence.hasLinkWrite).toBe(false);
  });

  // The commonest shape a tie hits: a session that touched no PRs. Both lanes
  // would have written (a clear-to-null and a `deleteMany`), so the skip really
  // did suppress a write even though neither lane carries evidence.
  it("reports a pending write for a recalculated-to-empty snapshot", () => {
    const evidence = resolveSessionPullRequestEvidence(
      baseSession({ prRefs: [] })
    );

    expect(evidence.hasBlobEvidence).toBe(false);
    expect(evidence.hasLinkEvidence).toBe(false);
    expect(evidence.hasBlobWrite).toBe(true);
    expect(evidence.hasLinkWrite).toBe(true);
  });

  it("reports evidence and a pending write for a populated snapshot", () => {
    const evidence = resolveSessionPullRequestEvidence(
      baseSession({
        prs: [{ num: 7, title: "PR #7", status: "merged" }],
        prRefs: [prRef(7)],
      })
    );

    expect(evidence.hasBlobEvidence).toBe(true);
    expect(evidence.hasLinkEvidence).toBe(true);
    expect(evidence.hasBlobWrite).toBe(true);
    expect(evidence.hasLinkWrite).toBe(true);
  });

  // The lanes are independent: an explicit `prs: []` is still a blob write (an
  // intentional clear of the rendered set) while `prRefs` decides its own lane.
  it("resolves each lane's write independently", () => {
    const evidence = resolveSessionPullRequestEvidence(
      baseSession({ prs: [] })
    );

    expect(evidence.hasBlobWrite).toBe(true);
    expect(evidence.hasLinkWrite).toBe(false);
  });
});
