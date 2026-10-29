/**
 * @file unreadable-parse-ingest-failure.test.ts
 * @description ISS-7625: `session_parse_unreadable` was silent on the exact case
 * it names — a transcript whose every line is malformed.
 *
 * Both parsers COMPUTED the parse-quality counts and then dropped them with a
 * `null` return, because no line yielded a usable timestamp. The collector shells
 * turned that `null` into `[]`, the manager skipped the per-session loop entirely
 * and sealed the source, and `observeSessionQuality` runs per imported SESSION — so
 * zero sessions meant zero calls and no `reportIngestFailure` was reachable at
 * all. The counters existed, the data existed, and it landed nowhere.
 *
 * Two things make a test here easy to get wrong, so they are pinned deliberately:
 *
 *  1. THE WORKER IS THE PRODUCTION PATH. A historical/boot import parses in the
 *     utility process, so a carry that only works in-process is dead on arrival.
 *     The first two tests call the worker's own entry point.
 *
 *  2. `sessions.length === 0` IS NOT A PROXY for this. A Codex child rollout with
 *     a present parent legitimately returns `[]` on every pass, so a counter
 *     keyed on the empty list would be dominated by healthy sources. The negative
 *     tests pin that a healthy zero stays silent.
 *
 * Fixtures are written with raw `writeFileSync`: `writeJsonl` JSON-stringifies
 * each element and so cannot produce a malformed line.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ImportIngestFailure } from "@closedloop-ai/telemetry-contract/app";
import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import { afterEach, test } from "vitest";
import { createClaudeCollector } from "../src/main/collectors/claude/claude-collector.js";
import { createCodexCollector } from "../src/main/collectors/codex/codex-collector.js";
import {
  createUnreadableParseReporter,
  parseQualityIngestFailures,
  reportUnreadableParseIngestFailures,
} from "../src/main/collectors/engine/collector-ingest-failure.js";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import { parseHistoricalSource as resolveParseInvoker } from "../src/main/collectors/engine/collector-manager-pass-resources.js";
import type { HistoricalParseRunner } from "../src/main/collectors/engine/historical-parse-runner.js";
import {
  type HistoricalParseResult,
  parseHistoricalSource,
  resetWorkerCollectorsForTesting,
} from "../src/main/collectors/engine/historical-parse-source.js";
// ISS-8627 keeps worker response construction beside the protocol shapes.
import {
  createHistoricalParseWorkerParsedResponse,
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import {
  Harness,
  type HarnessCollector,
} from "../src/main/collectors/types.js";
import { createMemoryIngestStoreProvider } from "./ingest-store-test-utils.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(async () => {
  resetWorkerCollectorsForTesting();
  await cleanupTempDirs();
});

const CLAUDE_SESSION_ID = "8f4c1c22-1111-4111-8111-111111111111";
const PARENT_ROLLOUT_ID = "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_ROLLOUT_ID = "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** A third rollout, all-malformed, used to latch a value before a healthy parse. */
const UNREADABLE_ROLLOUT_ID = "c3c3c3c3-cccc-4ccc-8ccc-cccccccccccc";

/**
 * Three lines that are not JSON at all. Genuinely malformed rather than merely
 * unexpected: `JSON.parse` throws on each, which is what the parsers count.
 */
const ALL_MALFORMED_BODY = '{"type":"user"\nnot json at all\n{"truncated":\n';

/** Write an all-malformed Claude transcript and return its collector + path. */
function claudeCollectorFor(body: string): {
  collector: HarnessCollector;
  source: string;
} {
  const root = makeTempDir("iss7625-claude-");
  const projectDir = path.join(root, "projects", "workspace-project");
  mkdirSync(projectDir, { recursive: true });
  const source = path.join(projectDir, `${CLAUDE_SESSION_ID}.jsonl`);
  writeFileSync(source, body, "utf8");
  const collector = createClaudeCollector({
    listSources: () => [source],
    watchRoots: () => [root],
    // Never touch the developer's real ~/Library Desktop history from a test.
    desktopSessionsDir: null,
  });
  return { collector, source };
}

/** One well-formed Codex rollout record line. */
function rolloutMetaLine(id: string, forkedFromId?: string): string {
  return JSON.stringify({
    timestamp: "2026-06-28T10:00:00.000Z",
    type: "session_meta",
    payload: {
      cwd: "/workspace/project",
      cli_version: "0.40.0",
      id,
      source: "exec",
      ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
    },
  });
}

/** Write Codex rollouts into a day-dir layout and return their collector. */
function codexCollectorFor(bodies: { id: string; body: string }[]): {
  collector: HarnessCollector;
  sources: string[];
} {
  const root = makeTempDir("iss7625-codex-");
  const dayDir = path.join(root, "2026", "06", "28");
  mkdirSync(dayDir, { recursive: true });
  const sources = bodies.map(({ id, body }, index) => {
    const source = path.join(
      dayDir,
      `rollout-2026-06-28T10-00-0${index}-${id}.jsonl`
    );
    writeFileSync(source, body, "utf8");
    return source;
  });
  const collector = createCodexCollector({
    sessionsDir: root,
    archivedDir: path.join(root, "archived"),
    listSources: () => sources,
  });
  return { collector, sources };
}

/** Collect every ingest-failure reason a parse quality warrants. */
function reasonsFor(quality: NormalizedParseQuality): ImportIngestFailure[] {
  const reasons: ImportIngestFailure[] = [];
  reportUnreadableParseIngestFailures((reason) => {
    reasons.push(reason);
  }, quality);
  return reasons;
}

test("ISS-7625: an all-malformed Claude transcript carries its counts out of the WORKER parse", async () => {
  const { collector, source } = claudeCollectorFor(ALL_MALFORMED_BODY);
  // Swap the worker's own collector factory — this is the function that runs
  // INSIDE the utility process, which is where production parses. Before this
  // fix it returned bare sessions and the counts died at the `null`.
  resetWorkerCollectorsForTesting(() => collector);

  const parsed = await parseHistoricalSource(Harness.Claude, source);

  assert.deepEqual(
    parsed.sessions,
    [],
    "fixture precondition: an unreadable transcript yields no session"
  );
  const quality = parsed.unreadableParseQuality;
  assert.ok(
    quality,
    "the out-of-process parse must return the counts as DATA — the main process holds the sink, and a sink cannot reach it from the worker"
  );
  assert.equal(quality.totalLines, 3);
  assert.equal(quality.malformedLines, 3);
  assert.deepEqual(
    reasonsFor(quality),
    [ImportIngestFailure.SessionParseUnreadable],
    "every line was lost, so this is unreadable exactly once — not degraded, and not silent"
  );
});

test("ISS-7625: an all-malformed Codex rollout carries its counts out of the WORKER parse", async () => {
  const { collector, sources } = codexCollectorFor([
    { id: PARENT_ROLLOUT_ID, body: ALL_MALFORMED_BODY },
  ]);
  resetWorkerCollectorsForTesting(() => collector);

  const parsed = await parseHistoricalSource(Harness.Codex, sources[0] ?? "");

  assert.deepEqual(parsed.sessions, []);
  const quality = parsed.unreadableParseQuality;
  assert.ok(
    quality,
    "the Codex core dropped `totalLines`/`malformedLines` as function locals on its no-timestamp return"
  );
  assert.equal(quality.totalLines, 3);
  assert.equal(quality.malformedLines, 3);
  assert.deepEqual(reasonsFor(quality), [
    ImportIngestFailure.SessionParseUnreadable,
  ]);
});

test("ISS-7625: the counts survive the worker response schema round trip", async () => {
  const { collector, source } = claudeCollectorFor(ALL_MALFORMED_BODY);
  resetWorkerCollectorsForTesting(() => collector);
  const parsed = await parseHistoricalSource(Harness.Claude, source);
  const quality = parsed.unreadableParseQuality;
  assert.ok(quality);

  // The envelope the worker actually posts, through a structured-clone
  // equivalent and the REAL boundary schema. The Parsed branch is a plain
  // `z.object`, so a field the schema has not been taught is silently STRIPPED
  // rather than rejected — no error, no retry, the signal simply never arrives.
  const response = createHistoricalParseWorkerParsedResponse(
    "req-round-trip",
    [],
    undefined,
    // ISS-7696 inserted `resumeFromSessionIndex` ahead of the quality argument.
    undefined,
    quality
  );
  const result = historicalParseWorkerResponseSchema.safeParse(
    JSON.parse(JSON.stringify(response))
  );

  assert.equal(
    result.success,
    true,
    `the envelope carrying the counts must validate: ${result.success ? "" : JSON.stringify(result.error?.issues)}`
  );
  const carried =
    result.success &&
    result.data.type === HistoricalParseWorkerResponseType.Parsed
      ? result.data.unreadableParseQuality
      : undefined;
  assert.deepEqual(
    carried,
    quality,
    "a stripped field is how this signal would go missing in silence, so the whole record must cross the boundary"
  );
});

test("ISS-7625: a pre-change worker payload still validates, and the field is OMITTED when absent", () => {
  // Cross-version discipline: an older worker sends no such key, and a parse
  // with nothing to report must not serialize `null` for it.
  const response = createHistoricalParseWorkerParsedResponse("req-empty", []);
  assert.ok(
    !("unreadableParseQuality" in response),
    "the key must be absent, not present-and-null"
  );

  const preChange = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "req-old-worker",
    sessions: [],
  });
  assert.equal(
    preChange.success,
    true,
    "a payload from a worker build that predates this field must validate unchanged"
  );
});

test("ISS-7625: the pass reports the failure on the worker path AND in process", async () => {
  const { collector, source } = claudeCollectorFor(ALL_MALFORMED_BODY);

  // In-process: this collector instance is the one that parsed, so the pass
  // drains it directly.
  const inProcess: ImportIngestFailure[] = [];
  const inProcessInvoker = resolveParseInvoker(
    collector,
    undefined,
    (reason) => inProcess.push(reason),
    () => true
  );
  assert.deepEqual(await inProcessInvoker(source, () => undefined), []);
  assert.deepEqual(
    inProcess,
    [ImportIngestFailure.SessionParseUnreadable],
    "the in-process pass must report exactly once"
  );

  // Worker path: the main-process collector never parsed, so the value can only
  // come off the wire. A runner that returns the counts is the whole contract.
  const viaWorker: ImportIngestFailure[] = [];
  const runner: HistoricalParseRunner = {
    parseSource: (): Promise<HistoricalParseResult> =>
      Promise.resolve({
        sessions: [],
        unreadableParseQuality: {
          totalLines: 3,
          malformedLines: 3,
          truncatedFinalLine: true,
        },
      }),
    stop: () => undefined,
  };
  const workerInvoker = resolveParseInvoker(
    collector,
    runner,
    (reason) => viaWorker.push(reason),
    () => true
  );
  assert.deepEqual(await workerInvoker(source, () => undefined), []);
  assert.deepEqual(
    viaWorker,
    [ImportIngestFailure.SessionParseUnreadable],
    "a main-process-only carry would report nothing here, which is the dead-on-arrival fix"
  );
});

test("ISS-7625: a readable transcript with no timestamp reports NOTHING", async () => {
  // The control for the case above. Every line parses; the transcript simply
  // carries no timestamp, so it is unimportable but not corrupt. A counter that
  // fired here would be dominated by healthy sources.
  const readableNoTimestamp = `${JSON.stringify({
    type: "summary",
    summary: "no timestamp anywhere",
  })}\n`;
  const { collector, source } = claudeCollectorFor(readableNoTimestamp);
  resetWorkerCollectorsForTesting(() => collector);

  const parsed = await parseHistoricalSource(Harness.Claude, source);

  assert.deepEqual(parsed.sessions, []);
  const quality = parsed.unreadableParseQuality;
  assert.ok(quality, "the counts are still carried — they are simply clean");
  assert.equal(quality.malformedLines, 0);
  assert.deepEqual(
    reasonsFor(quality),
    [],
    "a clean parse warrants no ingest failure, however empty its result"
  );
});

test("ISS-7625: a Codex child rollout with a present parent reports NOTHING", async () => {
  // The reason `sessions.length === 0` was never a usable proxy: this source
  // returns `[]` on EVERY pass, forever, and is perfectly healthy — its content
  // is imported under the parent.
  const { collector, sources } = codexCollectorFor([
    { id: PARENT_ROLLOUT_ID, body: `${rolloutMetaLine(PARENT_ROLLOUT_ID)}\n` },
    {
      id: CHILD_ROLLOUT_ID,
      body: `${rolloutMetaLine(CHILD_ROLLOUT_ID, PARENT_ROLLOUT_ID)}\n`,
    },
    { id: UNREADABLE_ROLLOUT_ID, body: ALL_MALFORMED_BODY },
  ]);
  const [, childSource, unreadableSource] = sources;

  // Latch a value first, on the SAME instance, and deliberately do not drain it.
  // Two production call sites parse through a collector without ever draining
  // (`data-revision-rebuild.ts`, `post-boot-maintenance.ts`), so a stale value
  // CAN be sitting in the slot when the next parse runs. Without the
  // clear-before-parse at the top of `parse`, the healthy child below would
  // inherit this one and report `session_parse_unreadable`.
  await collector.parse(unreadableSource ?? "");

  const sessions = await collector.parse(childSource ?? "");

  assert.deepEqual(
    sessions,
    [],
    "fixture precondition: a child with a present parent yields no session of its own"
  );
  assert.equal(
    collector.takeUnreadableParseQuality?.(),
    undefined,
    "the child is filtered out BEFORE the parser runs, and the slot must be cleared at the START of every parse, or a healthy source inherits the previous one's failure"
  );
});

test("ISS-7625: a CollectorManager pass reports the failure through onIngestFailure", async () => {
  // The manager is what wires the reporter into the parse invoker. Without this
  // test, deleting that argument at both call sites leaves every other test in
  // this file green while production returns to the exact pre-ISS-7625 silence.
  const { collector, source } = claudeCollectorFor(ALL_MALFORMED_BODY);
  const reasons: ImportIngestFailure[] = [];
  const stateDir = path.join(path.dirname(source), "state");
  await new Promise<void>((resolve) => {
    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      stateDir,
      emit: () => undefined,
      getCollectionMode: () => "disabled",
      catchupPollMs: null,
      cooperativeDelay: async () => undefined,
      onIngestFailure: (reason) => {
        reasons.push(reason);
      },
      onBootImportComplete: async () => {
        await manager.stop();
        resolve();
      },
      collectors: [collector],
    });
    manager.start();
  });

  assert.deepEqual(
    reasons,
    [ImportIngestFailure.SessionParseUnreadable],
    "a real import pass over an all-malformed source must emit the counter exactly once"
  );
});

test("ISS-7625: a report from a SUPERSEDED pass is suppressed", () => {
  // The generation gate, pinned directly on the reporter that owns it. A
  // stop()/restart leaves the source unmarked, so it is re-parsed next pass and
  // one transcript would otherwise be counted twice.
  const quality: NormalizedParseQuality = {
    totalLines: 3,
    malformedLines: 3,
    truncatedFinalLine: true,
  };
  const live: ImportIngestFailure[] = [];
  createUnreadableParseReporter(
    (reason) => live.push(reason),
    () => true
  )(quality);
  const superseded: ImportIngestFailure[] = [];
  createUnreadableParseReporter(
    (reason) => superseded.push(reason),
    () => false
  )(quality);

  assert.deepEqual(
    live,
    [ImportIngestFailure.SessionParseUnreadable],
    "the positive sibling: an active pass reports"
  );
  assert.deepEqual(superseded, [], "a superseded pass must not double-count");
});

test("ISS-7625: a no-session parse never borrows a reason that claims a session parsed", () => {
  // `session_parse_degraded` and `session_records_unrouted` both assert that a
  // SESSION parsed and lost content. Neither is true of a source that imported
  // nothing, so a partially-corrupt transcript with no timestamp stays silent
  // rather than reporting one of them.
  const partiallyCorrupt: NormalizedParseQuality = {
    totalLines: 4,
    malformedLines: 1,
    truncatedFinalLine: false,
    unknownRecords: 2,
  };
  assert.deepEqual(
    parseQualityIngestFailures(partiallyCorrupt),
    [
      ImportIngestFailure.SessionParseDegraded,
      ImportIngestFailure.SessionRecordsUnrouted,
    ],
    "fixture precondition: the shared classifier does return both for this quality"
  );

  const reasons: ImportIngestFailure[] = [];
  reportUnreadableParseIngestFailures((reason) => {
    reasons.push(reason);
  }, partiallyCorrupt);

  assert.deepEqual(
    reasons,
    [],
    "only `unreadable` describes a source that produced nothing"
  );
});

test("ISS-8142: a THROWING onIngestFailure sink never reaches the import pipeline", async () => {
  // `reportIngestFailure` wraps the sink in a bare try/catch, and every harness
  // in both ingest-failure suites passes a sink that pushes to an array — so
  // deleting that catch leaves the whole repo green while production loses an
  // entire import pass to a diagnostic. That is the worst possible consequence
  // for telemetry, and it is what this pins.
  //
  // Asserted on the DURABLE outcome rather than the counter: the pass completes,
  // the healthy rollout listed AFTER the failing one is still imported, and both
  // sources are still marked seen. A test that only checked "the sink threw and
  // nothing crashed" would pass even if the pass aborted after the throw.
  const { collector, sources } = codexCollectorFor([
    // The malformed source is FIRST, so the throw happens before the healthy
    // rollout is reached. If the throw escaped, the neighbour below would never
    // be imported and the assertion on `imported` would catch it.
    { id: UNREADABLE_ROLLOUT_ID, body: ALL_MALFORMED_BODY },
    { id: PARENT_ROLLOUT_ID, body: `${rolloutMetaLine(PARENT_ROLLOUT_ID)}\n` },
  ]);
  const [unreadableSource, healthySource] = sources;
  const imported: string[] = [];
  let sinkInvocations = 0;
  const stateDir = path.join(makeTempDir("iss8142-state-"), "state");
  const ingestStores = createMemoryIngestStoreProvider();

  await new Promise<void>((resolve) => {
    const manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          imported.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      stateDir,
      ingestStores: ingestStores.provider,
      emit: () => undefined,
      getCollectionMode: () => "disabled",
      catchupPollMs: null,
      cooperativeDelay: async () => undefined,
      onIngestFailure: () => {
        sinkInvocations += 1;
        throw new Error("exporter down");
      },
      onBootImportComplete: async () => {
        await manager.stop();
        resolve();
      },
      collectors: [collector],
    });
    manager.start();
  });

  // Positive control: without this the fixture could simply never have produced
  // an ingest failure, and every assertion below would hold vacuously.
  assert.ok(
    sinkInvocations >= 1,
    "the throwing sink must actually have been invoked"
  );
  assert.ok(
    imported.includes(PARENT_ROLLOUT_ID),
    `the healthy rollout after the failing one must still be imported: ${JSON.stringify(imported)}`
  );

  // The catchup cache is the durable "this source was imported" record. A pass
  // that died on the throw would leave it without either entry, and every source
  // would be re-parsed on the next launch.
  const entries = ingestStores.catchupCache("codex").peek()?.entries ?? {};
  assert.ok(
    Object.hasOwn(entries, healthySource ?? ""),
    `the healthy source was marked seen: ${JSON.stringify(entries)}`
  );
  assert.ok(
    Object.hasOwn(entries, unreadableSource ?? ""),
    `the source whose sink threw was still marked seen: ${JSON.stringify(entries)}`
  );
});
