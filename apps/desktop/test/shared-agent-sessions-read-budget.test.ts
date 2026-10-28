/**
 * @file shared-agent-sessions-read-budget.test.ts
 * @description ISS-9556 — the IPC READ-COST budget for a Sessions list request.
 *
 * The desktop list channel serializes its whole result across the Electron IPC
 * boundary, so its cost is two countable things: how many store round trips one
 * request makes, and how many rows it drags back to serialize. Both must be
 * functions of the requested PAGE, never of the local corpus — that is the
 * difference between a store that stays usable at 5,000 sessions and one that
 * degrades with every session the operator accumulates.
 *
 * The sibling suites pin neighbouring facts but not this one:
 * `shared-agent-sessions-count-only.test.ts` pins the route's op KIND sequence
 * over a two-row corpus, and `shared-agent-sessions-repository-population.test.ts`
 * bounds a single hydration's width against `SESSION_HYDRATION_WINDOW`. Neither
 * holds the cost FLAT while the corpus grows, which is the regression that
 * actually reaches a user.
 */
import assert from "node:assert/strict";
import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { describe, test } from "vitest";
import type { SessionCursorRow } from "../src/main/agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import type { TranscriptMainBlobState } from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * Two corpora an order of magnitude apart. The SMALL one is already larger than
 * a page, so both take the identical route and any difference between them is
 * corpus-driven cost rather than a different code path.
 */
const SMALL_CORPUS = 500;
const LARGE_CORPUS = 5000;

/** The page the renderer asks for. */
const PAGE_LIMIT = 50;

/**
 * The compute target a SIGNED-IN desktop resolves.
 *
 * whitlockk (#6844): this is what makes the budget below describe the path a user
 * actually takes. `buildSharedAgentSessionsListOptions` — the ONE builder both
 * the `list` and the `pageData` IPC handlers pass, and `SessionsView` reads
 * through `pageData` — always supplies a `computeTargetId` and a
 * `loadTranscriptBlobStates` delegate. Omit them and BOTH disclosure lanes
 * short-circuit before issuing a read, which is the offline/no-target fallback,
 * not a signed-in list.
 */
const COMPUTE_TARGET_ID = "compute-target-1";

/**
 * Store round trips a SIGNED-IN list request issues, and in this order:
 *
 *  1. `listSessionCursorPage` — the SQL page, applying `LIMIT`/`OFFSET` itself.
 *  2. `loadSyncedSessions` — one batched hydrate of that page's ids.
 *  3. `loadPendingOutboxIds` — the metadata-lane disclosure (PRD-536 E6).
 *  4. the transcript-blob lane (`listMainBlobStates`, injected as
 *     `loadTranscriptBlobStates`) — ISS-4647's per-page blob verdicts.
 *
 * Pinned as literals rather than read back from the route, so a path that
 * quietly grows a fifth read — a per-row enrichment, a second count, a
 * whole-corpus id enumeration — reddens here instead of moving the budget.
 *
 * Reads 3 and 4 are NOT overhead the budget is excusing: each is one round trip
 * whose payload is bounded by the PAGE (4) or by the outbox backlog (3), so the
 * flatness this suite asserts still holds. What the earlier revision of this
 * file budgeted at 2 was the fallback with both lanes skipped.
 */
const SIGNED_IN_STORE_OP_BUDGET = 4;

const SIGNED_IN_SOURCE_OPS = [
  "listSessionCursorPage",
  "loadSyncedSessions",
  "loadPendingOutboxIds",
];

/**
 * The same request with NO compute target: the offline / not-yet-registered
 * fallback, where both disclosure lanes are skipped by design rather than
 * failing. Budgeted separately and named for what it is, so neither number is
 * mistaken for the other.
 */
const NO_TARGET_STORE_OP_BUDGET = 2;

const NO_TARGET_SOURCE_OPS = ["listSessionCursorPage", "loadSyncedSessions"];

function buildCorpus(size: number): {
  cursorRows: SessionCursorRow[];
  sessions: Record<string, SyncedAgentSession>;
} {
  const cursorRows: SessionCursorRow[] = [];
  const sessions: Record<string, SyncedAgentSession> = {};
  for (let index = 0; index < size; index++) {
    const id = `sess-${String(index).padStart(6, "0")}`;
    cursorRows.push(cursor(id));
    sessions[id] = session({ id, cwd: `/tmp/corpus/${id}` });
  }
  return { cursorRows, sessions };
}

/** The corpus' first two ids, standing in for a real outbox backlog. */
function pendingIdsOf(size: number): string[] {
  return [0, 1]
    .filter((index) => index < size)
    .map((index) => `sess-${String(index).padStart(6, "0")}`);
}

/**
 * One list read over the REAL options the IPC handlers build: a compute target
 * plus a transcript-blob delegate.
 *
 * The transcript lane is injected rather than owned by the fake source (the real
 * store lives behind the db-host proxy), so its reads are recorded here and
 * folded into the op ledger the assertions below read.
 */
function readSignedInPage(size: number) {
  const source = createFakeSource({
    ...buildCorpus(size),
    pendingOutboxIds: pendingIdsOf(size),
  });
  const transcriptReads: string[][] = [];
  const response = getSharedAgentSessions(
    source,
    { limit: PAGE_LIMIT, offset: 0 },
    {
      computeTargetId: COMPUTE_TARGET_ID,
      loadTranscriptBlobStates: (externalSessionIds) => {
        transcriptReads.push([...externalSessionIds]);
        return Promise.resolve([] as TranscriptMainBlobState[]);
      },
    }
  );
  return { response, source, transcriptReads };
}

function readNoTargetPage(size: number) {
  const source = createFakeSource(buildCorpus(size));
  return {
    response: getSharedAgentSessions(source, { limit: PAGE_LIMIT, offset: 0 }),
    source,
  };
}

/** Every store round trip the read made, source-side and transcript-side. */
function storeOpCount(read: {
  source: { calls: unknown[] };
  transcriptReads: unknown[];
}): number {
  return read.source.calls.length + read.transcriptReads.length;
}

describe("ISS-9556 — Sessions list IPC read budget", () => {
  test("costs the same store round trips at 5,000 sessions as at 500", async () => {
    const small = readSignedInPage(SMALL_CORPUS);
    const smallResponse = await small.response;
    const large = readSignedInPage(LARGE_CORPUS);
    const largeResponse = await large.response;

    // Same ops, same order, ten times the corpus.
    assert.deepEqual(
      small.source.calls.map((call) => call.kind),
      SIGNED_IN_SOURCE_OPS
    );
    assert.deepEqual(
      large.source.calls.map((call) => call.kind),
      SIGNED_IN_SOURCE_OPS
    );
    assert.equal(storeOpCount(small), SIGNED_IN_STORE_OP_BUDGET);
    assert.equal(storeOpCount(large), SIGNED_IN_STORE_OP_BUDGET);

    // Both requests still describe their own corpus correctly, so the flat cost
    // above is a real page over a real population — not an early return.
    assert.equal(smallResponse.total, SMALL_CORPUS);
    assert.equal(largeResponse.total, LARGE_CORPUS);
  });

  test("consults both disclosure lanes, over the page and not the corpus", async () => {
    const { response, source, transcriptReads } =
      readSignedInPage(LARGE_CORPUS);
    const page = await response;

    // The transcript lane read exactly once, for exactly this page's ids. A
    // lane that asked for the corpus would still return the same verdicts for
    // the 50 rows on screen, so only its ARGUMENT can catch it.
    assert.equal(transcriptReads.length, 1);
    assert.equal(transcriptReads[0]?.length, PAGE_LIMIT);

    // The outbox lane read once, and was actually CONSULTED — the two backlog
    // ids disclose `pending` while the rest of the page reads `synced`. Without
    // this the lane could be short-circuiting and still cost its one op.
    const outboxReads = source.calls.filter(
      (call) => call.kind === "loadPendingOutboxIds"
    );
    assert.equal(outboxReads.length, 1);
    assert.deepEqual(
      page.items.slice(0, 3).map((item) => item.cloudSyncState),
      [
        AgentSessionCloudSyncState.Pending,
        AgentSessionCloudSyncState.Pending,
        AgentSessionCloudSyncState.Synced,
      ]
    );
  });

  test("serializes the requested page, never the corpus behind it", async () => {
    const { response, source } = readSignedInPage(LARGE_CORPUS);
    const page = await response;

    // What crosses the IPC boundary.
    assert.equal(page.items.length, PAGE_LIMIT);
    // What the hydrate pulled out of SQLite to build it. A route that hydrated
    // the corpus and sliced in memory would serialize the same 50 rows above
    // while reading 5,000 — so the page width alone cannot catch it.
    const hydrate = source.calls.find(
      (call) => call.kind === "loadSyncedSessions"
    );
    assert.equal(hydrate?.ids?.length, PAGE_LIMIT);
  });

  test("skips both disclosure lanes when there is no compute target", async () => {
    const { response, source } = readNoTargetPage(LARGE_CORPUS);
    const page = await response;

    // The fallback is CHEAPER, not equal — which is exactly why budgeting it as
    // if it were the signed-in path understated that path by two round trips.
    assert.deepEqual(
      source.calls.map((call) => call.kind),
      NO_TARGET_SOURCE_OPS
    );
    assert.equal(source.calls.length, NO_TARGET_STORE_OP_BUDGET);
    assert.ok(NO_TARGET_STORE_OP_BUDGET < SIGNED_IN_STORE_OP_BUDGET);
    // ISS-9004: no lane consulted ⇒ no claim. Never a false `pending` for rows
    // whose outbox state was never read, and — since ISS-9004 — never the false
    // `synced` this assertion used to pin either.
    assert.equal(page.items[0]?.cloudSyncState, undefined);
  });
});
