/**
 * @file agent-session-sync-monitored-activity-chunking.test.ts
 * @description ISS-9860 — monitored-session activity is PAGED across sync
 * parts instead of being capped at 50 events per target / 100 per session.
 * These tests pin:
 *   - full fidelity: every distinct event ships across the pages, none dropped,
 *     none duplicated, at most `MONITORED_ACTIVITY_SYNC_PAGE_EVENTS` DISTINCT
 *     events per page (a page counts events, not refs — F1);
 *   - the replicated base is stripped of carriers and activity-only refs, while
 *     the regular refs stay on every part;
 *   - each event rides EVERY ref of its target inside one page (F1);
 *   - pages are sealed by MEASUREMENT on both sizers (B1);
 *   - the ISS-7997 metadata degrade measures its budget without the carriers,
 *     so an oversized-metadata session with a large carrier chunks instead of
 *     dead-lettering (B2);
 *   - budget exhaustion degrades newest-first rather than dead-lettering;
 *   - a session over the page ceiling is chunked even when its bytes fit.
 */
import assert from "node:assert/strict";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import type { JsonObject } from "@repo/api/src/types/common";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  MonitoredSessionActivityEventKind,
  normalizeSyncedMonitoredSessionActivity,
  type SyncedMonitoredSessionActivityEvent,
} from "@repo/api/src/types/session-monitored-activity";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, test } from "vitest";
import { SESSION_PAYLOAD_BYTE_CAP } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import {
  gzipSyncPayloadSizer,
  identitySyncPayloadSizer,
  type SyncPayloadSizer,
} from "../src/main/agent-sync/agent-session-sync-compression.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  chunkOversizedSession,
  estimateSessionPayloadBytes,
  type PreparedAgentSessionPayload,
  prepareAgentSessionPayload,
} from "../src/main/agent-sync/agent-session-sync-payload.js";
import {
  MONITORED_ACTIVITY_SYNC_PAGE_EVENTS,
  monitoredActivityPageItems,
  monitoredActivityPageRefs,
  sessionWithoutMonitoredActivity,
} from "../src/main/agent-sync/monitored-activity-sync-pages.js";
import { MonitoredSessionCliRefMethod } from "../src/main/collectors/parsing/monitored-session-activity.js";

const REPOSITORY = "closedloop-ai/closedloop-ai";
const BRANCH = "feat/iss-9860";
const OTHER_BRANCH = "feat/iss-9860-other";
const BASE_MS = Date.parse("2026-09-01T10:00:00.000Z");
const LARGE_CAP = 64 * 1024 * 1024;

function buildSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "sess-monitored",
    name: "Monitored session",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/wt",
    model: "claude-opus-4",
    startedAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

/** `count` distinct events, one second apart, newest LAST so sorting is observable. */
function buildEvents(
  count: number,
  prefix: string
): SyncedMonitoredSessionActivityEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: MonitoredSessionActivityEventKind.AgentAction,
    sourceEventId: `monitored_session_v1:${prefix}-${index.toString().padStart(6, "0")}`,
    occurredAt: new Date(BASE_MS + index * 1000).toISOString(),
    completeness: BranchActivityEvidenceCompleteness.Complete,
  }));
}

function branchRef(
  branchName: string,
  events: SyncedMonitoredSessionActivityEvent[],
  overrides: Partial<
    Extract<SyncedArtifactRef, { kind: typeof ArtifactRefTargetKind.Branch }>
  > = {}
): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: REPOSITORY,
    branchName,
    method: ArtifactRefMethod.McpToolCall,
    relation: ArtifactRefRelation.Created,
    monitoredSessionActivity: {
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events,
    },
    ...overrides,
  };
}

function activityOnlyRef(
  branchName: string,
  events: SyncedMonitoredSessionActivityEvent[]
): SyncedArtifactRef {
  return branchRef(branchName, events, {
    method: ArtifactRefMethod.UrlInMessage,
    relation: ArtifactRefRelation.Referenced,
    monitoredActivityOnly: true,
  });
}

function chunksOf(prepared: PreparedAgentSessionPayload): SyncedAgentSession[] {
  if (prepared.kind !== "chunked") {
    throw new Error(`expected chunked, got ${prepared.kind}`);
  }
  return [prepared.firstChunk, ...prepared.remainingChunks];
}

function carriedEventIds(chunk: SyncedAgentSession): Set<string> {
  const ids = new Set<string>();
  for (const ref of chunk.artifactRefs ?? []) {
    if (ref.kind !== ArtifactRefTargetKind.Branch) {
      continue;
    }
    for (const event of ref.monitoredSessionActivity?.events ?? []) {
      ids.add(`${ref.branchName}\u0000${event.sourceEventId}`);
    }
  }
  return ids;
}

function pageChunks(chunks: SyncedAgentSession[]): SyncedAgentSession[] {
  return chunks.filter((chunk) => carriedEventIds(chunk).size > 0);
}

function baseChunks(chunks: SyncedAgentSession[]): SyncedAgentSession[] {
  return chunks.filter((chunk) => carriedEventIds(chunk).size === 0);
}

/** The ISS-7997 fixture: every compaction dimension admits it, 1 MiB raw. */
function oversizedMetadata(buckets = 8): JsonObject {
  const metadata: JsonObject = {};
  for (let key = 0; key < buckets; key++) {
    metadata[`bucket${key}`] = Array.from({ length: 100 }, () => {
      const row: Record<string, number> = {};
      for (let field = 0; field < 80; field++) {
        row[`f${field}`] = 1_234_567_890;
      }
      return row;
    });
  }
  return metadata;
}

/** Index and size of the first chunk over `maxBytes`, or null when all fit. */
function firstOversizedChunk(
  chunks: SyncedAgentSession[],
  maxBytes: number,
  sizer: SyncPayloadSizer
): { index: number; bytes: number } | null {
  for (const [index, chunk] of chunks.entries()) {
    const bytes = estimateSessionPayloadBytes(chunk, sizer);
    if (bytes > maxBytes) {
      return { index, bytes };
    }
  }
  return null;
}

describe("ISS-9860: monitored-session activity is paged, never capped", () => {
  test("a session over the page ceiling is chunked even when its bytes fit", () => {
    const over = buildSession({
      artifactRefs: [
        branchRef(
          BRANCH,
          buildEvents(MONITORED_ACTIVITY_SYNC_PAGE_EVENTS + 1, "over")
        ),
      ],
    });
    const at = buildSession({
      artifactRefs: [
        branchRef(
          BRANCH,
          buildEvents(MONITORED_ACTIVITY_SYNC_PAGE_EVENTS, "at")
        ),
      ],
    });
    assert.equal(prepareAgentSessionPayload(over, LARGE_CAP).kind, "chunked");
    assert.equal(prepareAgentSessionPayload(at, LARGE_CAP).kind, "session");
  });

  test("every distinct event ships exactly once across pages of at most the ceiling (full fidelity)", () => {
    const total = 2500;
    const session = buildSession({
      events: [
        {
          externalEventId: "ev-1",
          eventType: "ToolUse",
          toolName: "Read",
          createdAt: "2026-09-01T10:00:00.000Z",
        },
      ],
      artifactRefs: [branchRef(BRANCH, buildEvents(total, "fidelity"))],
    });
    const chunks = chunksOf(prepareAgentSessionPayload(session, LARGE_CAP));
    const pages = pageChunks(chunks);
    // COUNTERFACTUAL: a producer that ships only the newest 50/100 (the removed
    // caps) or that replicates the carrier into every chunk fails one of these.
    assert.equal(
      pages.length,
      Math.ceil(total / MONITORED_ACTIVITY_SYNC_PAGE_EVENTS)
    );
    const seen = new Map<string, number>();
    for (const page of pages) {
      const ids = carriedEventIds(page);
      assert.ok(ids.size <= MONITORED_ACTIVITY_SYNC_PAGE_EVENTS);
      for (const id of ids) {
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
    }
    assert.equal(seen.size, total);
    assert.ok([...seen.values()].every((count) => count === 1));
    // The base carries the regular ref with its carrier stripped, and the
    // events stream stays where it was.
    const bases = baseChunks(chunks);
    assert.ok(bases.length >= 1);
    for (const base of bases) {
      assert.equal(base.artifactRefs?.length, 1);
      assert.equal(
        "monitoredSessionActivity" in (base.artifactRefs?.[0] ?? {}),
        false
      );
    }
    assert.equal(chunks.flatMap((chunk) => chunk.events).length, 1);
    for (const page of pages) {
      assert.deepEqual(page.events, []);
    }
  });

  test("F1: an event rides every ref of its target inside one page, and the page counts distinct events", () => {
    const total = 1200;
    const events = buildEvents(total, "multi-ref");
    const session = buildSession({
      artifactRefs: [
        branchRef(BRANCH, events),
        branchRef(BRANCH, events, {
          relation: ArtifactRefRelation.Workspace,
          method: MonitoredSessionCliRefMethod.GitCheckout,
        }),
        branchRef(BRANCH, events, {
          relation: ArtifactRefRelation.Referenced,
          method: MonitoredSessionCliRefMethod.GitPush,
        }),
      ],
    });
    assert.equal(monitoredActivityPageItems(session).length, total);
    const pages = pageChunks(
      chunksOf(prepareAgentSessionPayload(session, LARGE_CAP))
    );
    assert.equal(pages.length, 2);
    // COUNTERFACTUAL: keying items by ref makes 3,600 items, four pages, and
    // splits one event across two pages.
    assert.equal(
      carriedEventIds(pages[0]).size,
      MONITORED_ACTIVITY_SYNC_PAGE_EVENTS
    );
    assert.equal(
      carriedEventIds(pages[1]).size,
      total - MONITORED_ACTIVITY_SYNC_PAGE_EVENTS
    );
    for (const page of pages) {
      const refs = (page.artifactRefs ?? []).filter(
        (ref) => ref.kind === ArtifactRefTargetKind.Branch
      );
      assert.equal(refs.length, 3);
      const perRef = refs.map((ref) =>
        (ref.monitoredSessionActivity?.events ?? [])
          .map((event) => event.sourceEventId)
          .sort()
      );
      assert.deepEqual(perRef[0], perRef[1]);
      assert.deepEqual(perRef[1], perRef[2]);
    }
    // Newest first: the first page holds the newest 1,000.
    const firstPageIds = carriedEventIds(pages[0]);
    const newest = events.slice(-MONITORED_ACTIVITY_SYNC_PAGE_EVENTS);
    for (const event of newest) {
      assert.ok(firstPageIds.has(`${BRANCH}\u0000${event.sourceEventId}`));
    }
  });

  test("activity-only refs leave the base and ride only the page naming their target", () => {
    const regular = buildEvents(1100, "regular");
    const transportOnly = buildEvents(30, "transport-only");
    const session = buildSession({
      artifactRefs: [
        branchRef(BRANCH, regular),
        activityOnlyRef(OTHER_BRANCH, transportOnly),
      ],
    });
    const chunks = chunksOf(prepareAgentSessionPayload(session, LARGE_CAP));
    for (const base of baseChunks(chunks)) {
      assert.deepEqual(
        (base.artifactRefs ?? []).map((ref) =>
          ref.kind === ArtifactRefTargetKind.Branch ? ref.branchName : ref.kind
        ),
        [BRANCH]
      );
    }
    const pages = pageChunks(chunks);
    const pagesNamingOther = pages.filter((page) =>
      (page.artifactRefs ?? []).some(
        (ref) =>
          ref.kind === ArtifactRefTargetKind.Branch &&
          ref.branchName === OTHER_BRANCH
      )
    );
    // The transport-only events are the OLDEST (their timestamps start at
    // BASE_MS like the regular ones, so they interleave into the first page by
    // time); wherever they land, the activity-only ref appears on exactly the
    // pages that carry its events and nowhere else.
    for (const page of pages) {
      const carriesOther = [...carriedEventIds(page)].some((id) =>
        id.startsWith(`${OTHER_BRANCH}\u0000`)
      );
      assert.equal(pagesNamingOther.includes(page), carriesOther);
      // The regular ref is on every page, carrier or not.
      assert.ok(
        (page.artifactRefs ?? []).some(
          (ref) =>
            ref.kind === ArtifactRefTargetKind.Branch &&
            ref.branchName === BRANCH
        )
      );
    }
    const shipped = new Set(
      pages.flatMap((page) => [...carriedEventIds(page)])
    );
    assert.equal(shipped.size, regular.length + transportOnly.length);
  });

  test("a declared-Partial target stays Partial on every page; Complete targets stay Complete", () => {
    const session = buildSession({
      artifactRefs: [
        branchRef(BRANCH, buildEvents(1050, "complete")),
        branchRef(OTHER_BRANCH, buildEvents(20, "partial"), {
          monitoredSessionActivity: {
            completeness: BranchActivityEvidenceCompleteness.Partial,
            events: buildEvents(20, "partial"),
          },
        }),
      ],
    });
    const pages = pageChunks(
      chunksOf(prepareAgentSessionPayload(session, LARGE_CAP))
    );
    let sawPartial = false;
    for (const page of pages) {
      for (const ref of page.artifactRefs ?? []) {
        if (
          ref.kind !== ArtifactRefTargetKind.Branch ||
          !ref.monitoredSessionActivity
        ) {
          continue;
        }
        const expected =
          ref.branchName === OTHER_BRANCH
            ? BranchActivityEvidenceCompleteness.Partial
            : BranchActivityEvidenceCompleteness.Complete;
        assert.equal(ref.monitoredSessionActivity.completeness, expected);
        sawPartial ||= ref.branchName === OTHER_BRANCH;
      }
    }
    assert.ok(sawPartial);
  });

  for (const [label, sizer] of [
    ["identity", identitySyncPayloadSizer],
    ["gzip", gzipSyncPayloadSizer],
  ] as const) {
    test(`B1 (${label} sizer): every stamped page is measured within the cap — 100 activity-only refs x 10 events plus 100 regular refs`, () => {
      const artifactRefs: SyncedArtifactRef[] = [];
      for (let index = 0; index < 100; index++) {
        artifactRefs.push(
          branchRef(`feat/regular-${index}`, buildEvents(3, `regular-${index}`))
        );
      }
      for (let index = 0; index < 100; index++) {
        artifactRefs.push(
          activityOnlyRef(
            `feat/transport-${index}`,
            buildEvents(10, `transport-${index}`)
          )
        );
      }
      const session = buildSession({ artifactRefs });
      // A cap the ref set fits but the carriers do not, so pages must split
      // below the event ceiling on bytes alone.
      const stripped = estimateSessionPayloadBytes(
        { ...session, artifactRefs: artifactRefs.slice(0, 100) },
        sizer
      );
      const maxBytes = Math.max(stripped + 12_000, 32 * 1024);
      const prepared = prepareAgentSessionPayload(session, maxBytes, sizer);
      const chunks = chunksOf(prepared);
      // COUNTERFACTUAL: sizing a page by summing item JSON under-counts the
      // per-ref carrier wrappers and the activity-only envelopes, and a page
      // then lands over the cap and dead-letters on every re-prepare.
      assert.equal(firstOversizedChunk(chunks, maxBytes, sizer), null);
      const shipped = new Set(
        pageChunks(chunks).flatMap((page) => [...carriedEventIds(page)])
      );
      assert.equal(shipped.size, 100 * 3 + 100 * 10);
    });
  }

  test("B2: oversized metadata plus a 5,000-event carrier chunks on the identity sizer, never dead-letters", () => {
    const session = buildSession({
      metadata: oversizedMetadata(),
      artifactRefs: [branchRef(BRANCH, buildEvents(5000, "b2"))],
    });
    const prepared = prepareAgentSessionPayload(
      session,
      SESSION_PAYLOAD_BYTE_CAP
    );
    // COUNTERFACTUAL: measuring the degrade budget against the full carriers
    // drives it below zero, `chunkWithBoundedMetadata` returns null, and the
    // session is prepared `dead-letter`.
    const chunks = chunksOf(prepared);
    assert.equal(
      firstOversizedChunk(
        chunks,
        SESSION_PAYLOAD_BYTE_CAP,
        identitySyncPayloadSizer
      ),
      null
    );
    const shipped = new Set(
      pageChunks(chunks).flatMap((page) => [...carriedEventIds(page)])
    );
    assert.equal(shipped.size, 5000);
  });

  test("budget exhaustion degrades newest-first, keeps the session shipping, and stamps the shipped pages Partial", () => {
    const events = buildEvents(3000, "degrade");
    // 396 padded events at four per chunk consume 99 of the 100 chunks, so the
    // three pages the carrier needs get exactly one.
    const padding = "x".repeat(20_000);
    const session = buildSession({
      events: Array.from({ length: 396 }, (_, index) => ({
        externalEventId: `ev-${index}`,
        eventType: "ToolUse",
        toolName: padding,
        createdAt: "2026-09-01T10:00:00.000Z",
      })),
      artifactRefs: [branchRef(BRANCH, events)],
    });
    const emptyBase = estimateSessionPayloadBytes(
      chunkOversizedSession(
        { ...session, events: [], artifactRefs: [] },
        LARGE_CAP
      )[0]
    );
    const oneEvent = Buffer.byteLength(JSON.stringify(session.events[0]));
    const maxBytes = emptyBase + 4 * (oneEvent + 1) + 2048;
    const chunks = chunkOversizedSession(session, maxBytes);
    // COUNTERFACTUAL: propagating the page packer's exhaustion as `[]` (the
    // required-stream rule) dead-letters a session whose events shipped fine.
    assert.equal(chunks.length, 100);
    assert.equal(chunks.flatMap((chunk) => chunk.events).length, 396);
    const shipped = new Set(
      pageChunks(chunks).flatMap((page) => [...carriedEventIds(page)])
    );
    assert.ok(shipped.size < events.length, "a tail must have been dropped");
    assert.ok(shipped.size > 0, "some pages must have shipped");
    // What shipped is the newest prefix, not an arbitrary slice.
    const newest = events.slice(events.length - shipped.size);
    for (const event of newest) {
      assert.ok(shipped.has(`${BRANCH}\u0000${event.sourceEventId}`));
    }
    // COUNTERFACTUAL: leaving the shipped carriers `Complete` presents the
    // prefix as the whole set — the declared-truncation honesty the removed
    // caps had, lost.
    for (const page of pageChunks(chunks)) {
      for (const ref of page.artifactRefs ?? []) {
        if (ref.kind === ArtifactRefTargetKind.Branch) {
          assert.equal(
            ref.monitoredSessionActivity?.completeness,
            BranchActivityEvidenceCompleteness.Partial
          );
        }
      }
    }
    // Every page stayed within the cap after the stamp.
    assert.equal(
      firstOversizedChunk(chunks, maxBytes, identitySyncPayloadSizer),
      null
    );
  });

  test("when no page fits and nothing else built a chunk, the split fails instead of acking a stripped base", () => {
    const session = buildSession({
      artifactRefs: [branchRef(BRANCH, buildEvents(1200, "nothing-fits"))],
    });
    // A cap the carrier-stripped base fits with no room for even one event.
    const strippedBase = estimateSessionPayloadBytes(
      chunkOversizedSession(
        sessionWithoutMonitoredActivity(session),
        LARGE_CAP
      )[0]
    );
    const maxBytes = strippedBase + 40;
    // The base itself fits at this cap — the failure below is the guard's.
    assert.equal(
      chunkOversizedSession(sessionWithoutMonitoredActivity(session), maxBytes)
        .length,
      1
    );
    // COUNTERFACTUAL: `committed = chunks.length > 0 ? chunks : [baseSession]`
    // without the monitored fallback ships the carrier-less base and drops all
    // 1,200 events with nothing marking the loss. The fallback re-splits with
    // the carriers replicated; at this cap that base overflows too, so the
    // split fails and the caller degrades or dead-letters.
    assert.deepEqual(chunkOversizedSession(session, maxBytes), []);
  });

  test("when the required streams spend the whole chunk budget, the carriers ride every part instead of being dropped", () => {
    const events = buildEvents(5, "replicated");
    // 400 padded events at four per chunk fill all 100 chunks, so no page can
    // be appended at all; the carrier is small enough to ride each base.
    const padding = "x".repeat(20_000);
    const session = buildSession({
      events: Array.from({ length: 400 }, (_, index) => ({
        externalEventId: `ev-${index}`,
        eventType: "ToolUse",
        toolName: padding,
        createdAt: "2026-09-01T10:00:00.000Z",
      })),
      artifactRefs: [branchRef(BRANCH, events)],
    });
    const emptyBase = estimateSessionPayloadBytes(
      chunkOversizedSession(
        { ...session, events: [], artifactRefs: [] },
        LARGE_CAP
      )[0]
    );
    const oneEvent = Buffer.byteLength(JSON.stringify(session.events[0]));
    const maxBytes = emptyBase + 4 * (oneEvent + 1) + 2048;
    const chunks = chunkOversizedSession(session, maxBytes);
    // COUNTERFACTUAL: treating "no page shipped" like a dropped tail leaves
    // 100 event chunks with no carrier anywhere — every monitored event gone,
    // nothing stamped Partial. The pre-paging shape delivered them.
    assert.equal(chunks.length, 100);
    assert.equal(chunks.flatMap((chunk) => chunk.events).length, 400);
    for (const chunk of chunks) {
      const ids = carriedEventIds(chunk);
      assert.equal(ids.size, events.length);
      for (const ref of chunk.artifactRefs ?? []) {
        if (ref.kind === ArtifactRefTargetKind.Branch) {
          assert.equal(
            ref.monitoredSessionActivity?.completeness,
            BranchActivityEvidenceCompleteness.Complete
          );
        }
      }
    }
    assert.equal(
      firstOversizedChunk(chunks, maxBytes, identitySyncPayloadSizer),
      null
    );
  });

  test("a conflicting copy of an event identity rides the page and the cloud normalizer drops it as Partial; an identical copy is deduped", () => {
    const events = buildEvents(3, "conflict");
    const conflicting = {
      ...events[0],
      kind: MonitoredSessionActivityEventKind.AgentRead,
    };
    const session = buildSession({
      artifactRefs: [
        branchRef(BRANCH, events),
        branchRef(BRANCH, [conflicting, events[1]], {
          relation: ArtifactRefRelation.Workspace,
          method: MonitoredSessionCliRefMethod.GitCheckout,
        }),
      ],
    });
    const items = monitoredActivityPageItems(session);
    // 3 distinct identities, one of them carried twice with differing kinds.
    assert.equal(items.length, 4);
    assert.equal(
      items.filter(
        (item) => item.event.sourceEventId === events[0].sourceEventId
      ).length,
      2
    );
    // Both copies land in the one page carrier the target gets, so the cloud's
    // shared normalizer — not `collectCandidates` — is what meets the conflict:
    // it drops that identity and stamps the target Partial. No copy wins.
    const pageRefs = monitoredActivityPageRefs(session, items);
    const carriers = pageRefs.flatMap((ref) =>
      ref.kind === ArtifactRefTargetKind.Branch &&
      ref.branchName === BRANCH &&
      ref.monitoredSessionActivity
        ? [ref.monitoredSessionActivity]
        : []
    );
    assert.equal(carriers.length, 2);
    for (const carrier of carriers) {
      assert.equal(
        carrier.events.filter(
          (event) => event.sourceEventId === events[0].sourceEventId
        ).length,
        2
      );
      const normalized = normalizeSyncedMonitoredSessionActivity(carrier);
      assert.ok(normalized);
      assert.equal(
        normalized.completeness,
        BranchActivityEvidenceCompleteness.Partial
      );
      assert.deepEqual(
        normalized.events.map((event) => event.sourceEventId).sort(),
        [events[1].sourceEventId, events[2].sourceEventId].sort()
      );
    }
  });

  test("a session without carriers keeps its pre-ISS-9860 chunk shape", () => {
    const session = buildSession({
      events: Array.from({ length: 50 }, (_, index) => ({
        externalEventId: `ev-${index}`,
        eventType: "ToolUse",
        toolName: "Read",
        createdAt: "2026-09-01T10:00:00.000Z",
      })),
      artifactRefs: [
        {
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPOSITORY,
          branchName: BRANCH,
          method: ArtifactRefMethod.McpToolCall,
          relation: ArtifactRefRelation.Created,
        },
      ],
    });
    const maxBytes =
      estimateSessionPayloadBytes({ ...session, events: [] }) + 400;
    const chunks = chunkOversizedSession(session, maxBytes);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.deepEqual(chunk.artifactRefs, session.artifactRefs);
    }
  });
});
