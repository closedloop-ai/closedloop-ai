/**
 * @file historical-parse-budget-continuation.test.ts
 * @description ISS-7696 — a source whose parse exceeds the worker response
 * budget must RESUME, not restart.
 *
 * Before this ticket the request was `{type, requestId, collectorKey, source}`
 * and the clamp kept `sessions.slice(0, index)`, so there was nothing to ask
 * with and nothing to ask for: every pass re-parsed the whole source, delivered
 * the identical prefix, and `markSourceImported` refused the seal forever. The
 * reproduction is the first test below, run in the opposite direction — it
 * asserts the SESSIONS that arrive on the second pass, because a suite that only
 * checked the token's value would pass just as green against a worker that
 * ignored it.
 *
 * The first test deliberately drives the REAL runner, the REAL worker-side
 * request handler, the REAL clamp and the REAL OpenCode seal gate, because every
 * one of those was a place the continuation could be dropped and the previous
 * ticket's honesty fix is what stands between a short import and a silent one.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parseHistoricalSource as boundedParseInvoker } from "../src/main/collectors/engine/collector-manager-pass-resources.js";
import {
  handleHistoricalParseRequest,
  resetWorkerCollectorsForTesting,
} from "../src/main/collectors/engine/historical-parse-source.js";
import { MIN_RESPONSE_TEXT_CAP } from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";
import {
  createHistoricalParseWorkerFailedResponse,
  type HistoricalParseWorkerRequest,
  HistoricalParseWorkerRequestType,
  type HistoricalParseWorkerResponse,
  HistoricalParseWorkerResponseType,
  historicalParseWorkerRequestSchema,
  historicalParseWorkerResponseSchema,
  resolveHistoricalParseResumeOffset,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { fitsResponseBudget } from "../src/main/collectors/engine/historical-parse-worker-response-budget.js";
import { createUtilityProcessHistoricalParseRunner } from "../src/main/collectors/engine/utility-process-historical-parse-runner.js";
import { createOpencodeCollector } from "../src/main/collectors/opencode/opencode-collector.js";
import {
  CollectorParseScope,
  Harness,
  type HarnessCollector,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import { rebuildParseSource } from "../src/main/dashboard/post-boot-maintenance.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { CollectorRecordsDroppedReason } from "../src/main/telemetry/telemetry-protocol.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import { makeSession } from "./historical-parse-worker-response-support.js";

/**
 * Enough sessions to need THREE windows, so the suite proves a continuation
 * rather than a single hand-off. The shape is the ISS-5854 count-bound fixture:
 * empty detail arrays (nothing for the array strategies to slice) and a `name`
 * below `MIN_RESPONSE_TEXT_CAP` (nothing for the text strategies to shorten), so
 * the only defeat left is the session COUNT — the one case that drops whole
 * sessions. Both properties are asserted in the test rather than trusted.
 */
const COUNT_BOUND_SESSIONS = 2000;
const COUNT_BOUND_NAME_LENGTH = 8000;
const MAX_PASSES = 8;
/** Which pass the manager abandons without reaching its seal gate. */
const ABANDONED_PASS = 0;

test("a budget-truncated source resumes across passes and lands every session exactly once", async () => {
  const all = countBoundSessions(COUNT_BOUND_SESSIONS);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss7696-"));
  const dbPath = path.join(dataDir, "opencode.db");
  fs.writeFileSync(dbPath, "");
  resetWorkerCollectorsForTesting(() => workerStubCollector(all));
  const children: FakeWorkerProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    forkWorker: () => {
      const child = new FakeWorkerProcess(handleHistoricalParseRequest);
      children.push(child);
      return child;
    },
  });
  // The production seam, not a stand-in: this is the invoker `CollectorManager`
  // builds for a harness with a worker runner, so the side-report replay that
  // arms the seal latch is the real one.
  const collector = createOpencodeCollector({
    dataDir,
    fingerprintPath: path.join(dataDir, "fingerprint"),
  });
  const parse = boundedParseInvoker(collector, runner);

  const deliveries: NormalizedSession[][] = [];
  const sealedPerPass: boolean[] = [];
  const listedBeforePass: string[][] = [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    listedBeforePass.push(collector.listSources());
    const snapshot = {
      fingerprint: collector.sourceFingerprint?.(dbPath) ?? null,
    };
    deliveries.push(await parse(dbPath, () => undefined));
    if (pass === ABANDONED_PASS) {
      // The manager ABANDONS this window: a mid-source yield to the live watcher
      // returns from the session loop before `markSourceImported`, so nothing
      // confirms the window and its unconsumed tail is still owed. The next pass
      // must re-deliver it. A continuation advanced by the worker's own
      // bookkeeping would skip it and let a later window seal over the hole.
      sealedPerPass.push(false);
      continue;
    }
    sealedPerPass.push(
      collector.markSourceImported?.(dbPath, snapshot) !== false
    );
    if (sealedPerPass.at(-1)) {
      break;
    }
  }
  const listedAfterSeal = collector.listSources();
  runner.stop();
  resetWorkerCollectorsForTesting();
  fs.rmSync(dataDir, { recursive: true, force: true });

  // The fixture is a COUNT-bound payload, or the strategies below it would have
  // reclaimed the bytes and nothing would have been dropped at all. Checked
  // against production's own floor and its own budget predicate, not against a
  // second copy of either number.
  assert.equal(
    fitsResponseBudget(all),
    false,
    "the fixture must be over budget to begin with, or it proves nothing"
  );
  assert.ok(
    COUNT_BOUND_NAME_LENGTH < MIN_RESPONSE_TEXT_CAP,
    "the name must sit below the response text floor, or this payload is not count-bound"
  );
  assert.ok(
    deliveries.length >= 4,
    `expected an abandoned pass plus at least three carrying ones, got ${deliveries.length}`
  );
  assert.deepEqual(
    sealedPerPass,
    [...deliveries.slice(0, -1).map(() => false), true],
    "every pass but the last must refuse the seal, and the last must take it"
  );

  // The abandoned window is RE-DELIVERED, not skipped. This is the edge that
  // separates a continuation the worker advanced for itself from one the import
  // earned: the manager returned before `markSourceImported`, so those sessions
  // were still owed and had to arrive again.
  assert.deepEqual(
    deliveries[1]?.map((session) => session.sessionId),
    deliveries[0]?.map((session) => session.sessionId),
    "a window no pass confirmed must be re-delivered whole on the next pass"
  );

  // AC: the pass after a CONFIRMED window reads the SUFFIX. Asserted on the
  // sessions that arrived, not on the token — a runner that sent the token and
  // ignored it would satisfy a token-only assertion while the tail stayed
  // unimported forever.
  const confirmed = deliveries.slice(1);
  const firstWindow = confirmed[0] ?? [];
  assert.ok(
    firstWindow.length > 0 && firstWindow.length < COUNT_BOUND_SESSIONS
  );
  assert.equal(
    confirmed[1]?.[0]?.sessionId,
    all[firstWindow.length]?.sessionId,
    "the pass after a confirmed window must start at the first session it did not carry"
  );

  // AC: every session imported, exactly once, in order — the no-skip and the
  // no-double-import edges, checked separately because they fail in opposite
  // directions at the same boundary.
  const deliveredIds = confirmed.flat().map((session) => session.sessionId);
  assert.equal(
    new Set(deliveredIds).size,
    deliveredIds.length,
    "no session may be delivered twice across the confirmed passes"
  );
  assert.deepEqual(
    deliveredIds,
    all.map((session) => session.sessionId),
    "the union of the windows must be the whole parse, in order and with no gap"
  );

  // AC: re-parsing stops once the source is sealed. The negative's positive
  // sibling is the same call before the seal, which must still list the store.
  assert.deepEqual(
    listedBeforePass[0],
    [dbPath],
    "an unsealed store must still be listed for import"
  );
  assert.deepEqual(
    listedAfterSeal,
    [],
    "a sealed store whose bytes have not moved must not be re-parsed"
  );

  const requests = children.flatMap((child) => child.requests);
  assert.equal(
    requests[0]?.resumeAfter,
    undefined,
    "the first request of a source carries no continuation"
  );
  assert.equal(
    requests[1]?.resumeAfter,
    undefined,
    "the request after an ABANDONED window carries no continuation either — nothing confirmed it"
  );
  assert.deepEqual(
    requests[2]?.resumeAfter,
    {
      sessionIndex: firstWindow.length,
      sessionId: firstWindow.at(-1)?.sessionId,
    },
    "the request after a CONFIRMED window names the last session that window carried"
  );
  // The old-main-process safety property: a response that defers sessions also
  // states that it dropped them, so a build that strips the unknown
  // `resumeAfter` key still refuses the seal instead of reading a short window
  // as the whole store.
  for (const response of children.flatMap((child) => child.responses)) {
    if (response.type === HistoricalParseWorkerResponseType.Parsed) {
      assert.equal(
        response.resumeAfter !== undefined &&
          response.droppedSessions === undefined,
        false,
        "a deferring response must never omit its dropped-session count"
      );
    }
  }
});

test("a resume token that no longer describes the parse restarts the source", async () => {
  const sessions = ["a", "b", "c", "d"].map((id) => makeSession(id));
  resetWorkerCollectorsForTesting(() => workerStubCollector(sessions));

  const resumed = await handleHistoricalParseRequest(
    parseRequest({ resumeAfter: { sessionIndex: 2, sessionId: "b" } })
  );
  const stale = await handleHistoricalParseRequest(
    parseRequest({ resumeAfter: { sessionIndex: 2, sessionId: "moved-away" } })
  );
  const shifted = await handleHistoricalParseRequest(
    parseRequest({ resumeAfter: { sessionIndex: 3, sessionId: "b" } })
  );
  resetWorkerCollectorsForTesting();

  // The positive sibling: a token that DOES describe this parse is honoured, so
  // the two restarts below are a decision and not a mechanism that never works.
  assert.deepEqual(deliveredIds(resumed), ["c", "d"]);
  assert.deepEqual(
    deliveredIds(stale),
    ["a", "b", "c", "d"],
    "a cursor naming a session this parse no longer has must restart, never slice"
  );
  assert.deepEqual(
    deliveredIds(shifted),
    ["a", "b", "c", "d"],
    "a cursor whose session moved index must restart — slicing there would skip one"
  );
});

test("a request that carries no continuation parses the source from the beginning", async () => {
  const sessions = ["a", "b", "c"].map((id) => makeSession(id));
  resetWorkerCollectorsForTesting(() => workerStubCollector(sessions));

  const response = await handleHistoricalParseRequest(parseRequest({}));
  resetWorkerCollectorsForTesting();

  assert.deepEqual(
    deliveredIds(response),
    ["a", "b", "c"],
    "the pre-ISS-7696 request shape must behave exactly as it did"
  );
  assert.equal(resolveHistoricalParseResumeOffset(sessions, undefined), 0);
  // Version skew the other way: a worker build older than a FUTURE request field
  // must strip it and parse, not reject the request and drop the source. The
  // request envelope is a plain `z.object` for exactly this reason, so a strict
  // boundary would turn a skew into a permanent `invalid historical parse
  // request`.
  const forwardCompatible = historicalParseWorkerRequestSchema.safeParse({
    type: HistoricalParseWorkerRequestType.ParseSource,
    requestId: "historical-parse-1",
    collectorKey: Harness.OpenCode,
    source: "/tmp/opencode.db",
    someFieldFromALaterBuild: 7,
  });
  assert.equal(forwardCompatible.success, true);
  assert.equal(
    Object.hasOwn(forwardCompatible.data ?? {}, "someFieldFromALaterBuild"),
    false
  );
  // ...and the canonical-value check the request contract has always owed.
  assert.equal(
    historicalParseWorkerRequestSchema.safeParse({
      type: HistoricalParseWorkerRequestType.ParseSource,
      requestId: "historical-parse-1",
      collectorKey: "unknown",
      source: "/tmp/session.jsonl",
    }).success,
    false
  );
});

test("a deferred window is not reported as a dropped one, and a droppable window still is", async () => {
  const telemetry: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => telemetry.push(event) });
  const logs: string[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: (message) => logs.push(message),
    forkWorker: () =>
      new FakeWorkerProcess((request) =>
        Promise.resolve(
          request.source.endsWith("deferred.db")
            ? truncatedResponse(request.requestId, {
                sessionIndex: 1,
                sessionId: "delivered",
              })
            : truncatedResponse(request.requestId)
        )
      ),
  });

  await runner.parseSource(Harness.OpenCode, "/tmp/deferred.db");
  const dropsAfterAdvance = sessionBudgetDrops(telemetry).length;
  // The SAME window a second time: the worker refused the token we sent and
  // started over, so this response did not move past the last one. OpenCode
  // selects `ORDER BY time_updated DESC` (opencode-parser.ts), so one touched
  // session reshuffles the prefix and produces exactly this — an under-import
  // that must not hide behind the word "deferred".
  await runner.parseSource(Harness.OpenCode, "/tmp/deferred.db", undefined, {
    sessionIndex: 1,
    sessionId: "delivered",
  });
  const dropsAfterStall = sessionBudgetDrops(telemetry).length;
  await runner.parseSource(Harness.OpenCode, "/tmp/lost.db");
  runner.stop();

  assert.equal(
    dropsAfterAdvance,
    0,
    "a window that will be asked for again is not a loss, and must not fire the loss monitor"
  );
  assert.equal(
    logs.some((message) => message.includes("deferred 42 whole session(s)")),
    true,
    "the deferral still reaches the local log, naming where it resumes"
  );
  assert.equal(
    dropsAfterStall,
    1,
    "a resume that did not advance is the ISS-5854 under-import, and must reach the monitor"
  );
  assert.equal(
    logs.some((message) => message.includes("did not advance")),
    true,
    "the local log must say WHY this source stopped converging"
  );
  // The other way to under-import, and the reason the split above is a real
  // distinction rather than a deleted monitor: a worker too old to send a
  // continuation at all keeps the ISS-5854 alert and its original wording.
  assert.deepEqual(
    sessionBudgetDrops(telemetry).map((drop) => drop.count),
    [42, 42]
  );
  assert.equal(
    logs.some((message) => message.includes("imported a SUBSET of its parse")),
    true
  );
});

test("the collector confirms a continuation only at the seal gate", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss7696-seal-"));
  fs.writeFileSync(path.join(dataDir, "opencode.db"), "");
  const dbPath = path.join(dataDir, "opencode.db");
  const collector = createOpencodeCollector({
    dataDir,
    fingerprintPath: path.join(dataDir, "fingerprint"),
  });
  const resumeAfter = { sessionIndex: 4, sessionId: "delivered-4" };

  await collector.applyParseSideReport?.({ droppedSessions: 9, resumeAfter });
  const beforeSealGate = collector.resumeAfterForSource?.(dbPath);
  const sealedTruncated = collector.markSourceImported?.(dbPath);
  const afterSealGate = collector.resumeAfterForSource?.(dbPath);
  // The final window: nothing dropped, nothing to resume from.
  await collector.applyParseSideReport?.({});
  const sealedWhole = collector.markSourceImported?.(dbPath);
  const afterCompletion = collector.resumeAfterForSource?.(dbPath);
  collector.resetIngestState?.();
  const afterReset = collector.resumeAfterForSource?.(dbPath);
  fs.rmSync(dataDir, { recursive: true, force: true });

  assert.equal(
    beforeSealGate,
    undefined,
    "a continuation the import has not consumed yet must not be handed out — the manager can still abandon that window"
  );
  // The positive sibling: reaching the seal gate is what earns it, even though
  // the seal itself is refused because this load was short.
  assert.deepEqual(afterSealGate, resumeAfter);
  assert.equal(sealedTruncated, false, "a truncated load must not seal");
  assert.equal(sealedWhole, true, "the load that carries the tail seals");
  assert.equal(
    afterCompletion,
    undefined,
    "a completed source must not be asked to resume past its own end"
  );
  assert.equal(
    afterReset,
    undefined,
    "a reset collector keeps no cursor into a store it is about to re-read"
  );
});

/**
 * ISS-7696 (whitlockk + codex review): the worker's boundary check reads ONE
 * session, so it cannot see a prefix that changed ahead of the cursor.
 *
 * After delivering `[A, B]` the token names `B` at index 2. A store that has
 * become `[X, B, …]` still presents `B` at that index, so the worker would
 * happily resume past an `X` it never delivered, and a later whole window would
 * clear the truncation latch and seal the source over the hole. A prefix row
 * edited in place ends the same way. Neither is visible at the boundary — both
 * move the store fingerprint — so the collector binds the continuation to the
 * fingerprint it was earned against and refuses to hand it out once that moves.
 *
 * The two halves are asserted through the SAME accessor: an absence assertion
 * whose selector never matches anything would pass against a collector that
 * returned `undefined` unconditionally and had stopped resuming altogether.
 */
test("a continuation is dropped once the store it was earned against has changed", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss7696-rebind-"));
  const dbPath = path.join(dataDir, "opencode.db");
  fs.writeFileSync(dbPath, "original-store");
  const collector = createOpencodeCollector({
    dataDir,
    fingerprintPath: path.join(dataDir, "fingerprint"),
  });
  const resumeAfter = { sessionIndex: 2, sessionId: "delivered-2" };

  await collector.applyParseSideReport?.({ droppedSessions: 5, resumeAfter });
  const parsedAgainst = collector.sourceFingerprint?.(dbPath) ?? null;
  const sealedTruncated = collector.markSourceImported?.(dbPath, {
    fingerprint: parsedAgainst,
  });
  const whileUnchanged = collector.resumeAfterForSource?.(dbPath);

  // The store moves under the cursor. A different byte LENGTH moves the
  // `name:mtimeMs:size` fingerprint without depending on clock granularity, so
  // this cannot pass or fail on how fast the machine ran the test.
  fs.writeFileSync(dbPath, "store-after-a-prefix-row-was-replaced");
  const afterStoreMoved = collector.resumeAfterForSource?.(dbPath);

  fs.rmSync(dataDir, { recursive: true, force: true });

  assert.ok(
    parsedAgainst,
    "the snapshot must carry a real parse-time fingerprint, or the promotion silently falls back to the CURRENT one and this test proves nothing about binding"
  );
  assert.equal(
    sealedTruncated,
    false,
    "a truncated load must still refuse the seal — the binding must not become a second way to seal short"
  );
  assert.deepEqual(
    whileUnchanged,
    resumeAfter,
    "an unchanged store must still resume, or the source never converges and this fix has only broken continuation"
  );
  assert.equal(
    afterStoreMoved,
    undefined,
    "a store that moved must restart from 0: the boundary check alone would accept a token whose prefix became [X, B] and skip X permanently"
  );
});

/**
 * ISS-7696 (synchronizing-susan review): the DATA_REVISION rebuild runs on the
 * SAME collector instances and the SAME worker as the ingest engine, and its
 * parse always starts at offset 0. Routing its report through the same courier
 * would let it land between an ingest pass's parse and that pass's seal, so the
 * seal would promote a continuation describing the REBUILD's window — a
 * different one — for a source the ingest pass is midway through.
 */
test("the data-revision rebuild cannot overwrite an ingest pass's continuation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss7696-rebuild-"));
  const dbPath = path.join(dataDir, "opencode.db");
  fs.writeFileSync(dbPath, "");
  const collector = createOpencodeCollector({
    dataDir,
    fingerprintPath: path.join(dataDir, "fingerprint"),
  });
  const runner = createUtilityProcessHistoricalParseRunner({
    forkWorker: () =>
      new FakeWorkerProcess((request) =>
        Promise.resolve(
          truncatedResponse(request.requestId, {
            sessionIndex: 1,
            sessionId: "rebuilt-from-zero",
          })
        )
      ),
  });
  const rebuildParse = rebuildParseSource(() => runner);
  const ingestWindow = { sessionIndex: 900, sessionId: "ingest-window-end" };

  // An ingest pass parks ITS window, then the rebuild re-reads the whole store
  // while that pass is still writing sessions, and only then does the ingest
  // pass reach its seal gate.
  await collector.applyParseSideReport?.({
    droppedSessions: 12,
    resumeAfter: ingestWindow,
  });
  await rebuildParse(collector, dbPath);
  const sealed = collector.markSourceImported?.(dbPath);
  const confirmed = collector.resumeAfterForSource?.(dbPath);
  runner.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });

  assert.deepEqual(
    confirmed,
    ingestWindow,
    "the seal must promote the window the IMPORT parked, not the one a rebuild re-read from zero"
  );
  // The positive sibling: the ingest pass's own truncation latch also survives
  // the rebuild, so a short load still refuses to seal.
  assert.equal(sealed, false);
});

/**
 * ISS-7696 (synchronizing-susan, third pass): the withheld-record FAILURE latch
 * is part of the same seal gate as the continuation, so it is scoped the same
 * way. The record itself is still written for a rebuild — ISS-5266 routes it
 * here on purpose — which is why this asserts both halves.
 */
test("a rebuild's withheld record lands without clearing the import pass's seal latch", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss7696-withheld-"));
  const dbPath = path.join(dataDir, "opencode.db");
  fs.writeFileSync(dbPath, "");
  const recorded: string[] = [];
  let recordShouldFail = true;
  const collector = createOpencodeCollector({
    dataDir,
    fingerprintPath: path.join(dataDir, "fingerprint"),
    recordWithheld: (report) => {
      if (recordShouldFail) {
        throw new Error("withheld write failed");
      }
      recorded.push(report.sourcePath);
    },
  });

  // The import pass's own withheld write fails, which must refuse the seal.
  await collector.applyParseSideReport?.({
    withheldOpencodeSubagents: { sourcePath: dbPath, roots: [] },
  });
  const sealedAfterFailure = collector.markSourceImported?.(dbPath);
  // A rebuild then re-reads the store and ITS write succeeds.
  recordShouldFail = false;
  await collector.applyParseSideReport?.({
    withheldOpencodeSubagents: {
      sourcePath: "/rebuilt/opencode.db",
      roots: [],
    },
    scope: CollectorParseScope.Rebuild,
  });
  const sealedAfterRebuild = collector.markSourceImported?.(dbPath);
  fs.rmSync(dataDir, { recursive: true, force: true });

  assert.equal(
    sealedAfterFailure,
    false,
    "a failed withheld write refuses the seal"
  );
  assert.equal(
    sealedAfterRebuild,
    false,
    "a rebuild's successful write must not answer the import pass's question about ITS OWN write"
  );
  // ...and the rebuild's record still LANDS, which is what ISS-5266 routes it
  // through this hook for. Scoping the latch must not silently stop that.
  assert.deepEqual(recorded, ["/rebuilt/opencode.db"]);
});

/**
 * The ISS-5854 count-bound corpus: nothing the value-level strategies can
 * reclaim, so the response budget can only be met by leaving whole sessions out.
 */
function countBoundSessions(total: number): NormalizedSession[] {
  return Array.from({ length: total }, (_, index) => ({
    ...makeSession(`count-bound-${index}`),
    name: "n".repeat(COUNT_BOUND_NAME_LENGTH),
  }));
}

/**
 * The collector the WORKER process resolves for a parse request. Synthetic
 * paths, hence the explicit unscoped-admission opt-out that
 * `isImportableCollectorSource` requires of injected collectors.
 */
function workerStubCollector(sessions: NormalizedSession[]): HarnessCollector {
  return {
    key: Harness.OpenCode,
    cacheName: "opencode",
    batch: true,
    allowUnscopedSourceAdmission: true,
    watchRoots: () => [],
    watchMatch: () => true,
    listSources: () => [],
    parse: () => Promise.resolve(sessions),
  };
}

function parseRequest(
  fields: Partial<HistoricalParseWorkerRequest>
): HistoricalParseWorkerRequest {
  return {
    type: HistoricalParseWorkerRequestType.ParseSource,
    requestId: "historical-parse-1",
    collectorKey: Harness.OpenCode,
    source: "/tmp/opencode.db",
    ...fields,
  };
}

function deliveredIds(response: HistoricalParseWorkerResponse): string[] {
  if (response.type !== HistoricalParseWorkerResponseType.Parsed) {
    throw new Error(`expected a parsed response, got ${response.message}`);
  }
  return response.sessions.map((session) => session.sessionId);
}

/** A schema-valid Parsed envelope that left 42 sessions behind. */
function truncatedResponse(
  requestId: string,
  resumeAfter?: { sessionIndex: number; sessionId: string }
): HistoricalParseWorkerResponse {
  return parsedEnvelope({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId,
    sessions: [makeSession("delivered")],
    droppedSessions: 42,
    ...(resumeAfter ? { resumeAfter } : {}),
  });
}

/**
 * Hand-built envelopes go through the real response schema before a test uses
 * them, so a fixture that the production boundary would reject cannot quietly
 * become the thing under test.
 */
function parsedEnvelope(candidate: unknown): HistoricalParseWorkerResponse {
  const parsed = historicalParseWorkerResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`invalid worker response fixture: ${parsed.error.message}`);
  }
  return parsed.data;
}

function sessionBudgetDrops(
  telemetry: readonly EnrichedTelemetryEvent[]
): Array<{ count: number }> {
  return telemetry.flatMap((event) => {
    const dropped = event.diagnostics?.collectorRecordsDropped;
    return dropped?.reason ===
      CollectorRecordsDroppedReason.SessionResponseBudget
      ? [{ count: dropped.count }]
      : [];
  });
}

/**
 * A utility-process stand-in that answers with whatever the caller's responder
 * returns — usually the REAL worker-side handler, so the request the runner
 * built is the request the production code reads.
 */
class FakeWorkerProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly requests: HistoricalParseWorkerRequest[] = [];
  readonly responses: HistoricalParseWorkerResponse[] = [];
  killed = false;
  private readonly respond: (
    request: HistoricalParseWorkerRequest
  ) => Promise<HistoricalParseWorkerResponse>;

  constructor(
    respond: (
      request: HistoricalParseWorkerRequest
    ) => Promise<HistoricalParseWorkerResponse>
  ) {
    super();
    this.respond = respond;
  }

  postMessage(request: HistoricalParseWorkerRequest): void {
    this.requests.push(request);
    this.respond(request).then(
      (response) => {
        this.responses.push(response);
        this.emit("message", response);
      },
      (error: unknown) => {
        this.emit(
          "message",
          createHistoricalParseWorkerFailedResponse(
            request.requestId,
            error instanceof Error ? error.message : String(error)
          )
        );
      }
    );
  }

  kill(): void {
    this.killed = true;
    this.emit("exit", 0);
  }
}
