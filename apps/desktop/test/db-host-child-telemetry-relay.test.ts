/**
 * @file db-host-child-telemetry-relay.test.ts
 * @description ISS-7109 — an event raised IN THE DB-HOST CHILD reaches the
 * monitored transport.
 *
 * ## What was broken, and why the existing coverage could not see it
 *
 * `Observability.init` has one production call site: the MAIN-process
 * composition root. The live hook that raises `collector.records_dropped`
 * (ISS-6417) does not run there — it runs inside the FEA-2038 DB-host
 * `utilityProcess`, whose module graph never initialises `Observability`. The
 * emit path ends in `Observability.telemetry?.emit(event)`, so with a null
 * `telemetry` the call returned having sent nothing, and every drop event was
 * discarded for the life of ISS-6417.
 *
 * `claude-unrepresentable-timestamp.test.ts` asserts that same event and passes
 * against the broken build, because it calls `Observability.init` in its own
 * process before driving the hook — i.e. it tests MAIN, and main was never the
 * broken half. That is the exact shape a test must not have here, so this suite
 * keeps the two processes apart:
 *
 *  - the CHILD phase runs with `Observability` UNINITIALISED, which is the real
 *    state of the DB-host process, and drives the real `openSqliteAgentDatabase`
 *    → `processEvent("SubagentStop")` path against a sidecar carrying a stamp no
 *    `Date` can represent;
 *  - the crossing is the verbatim message the production relay sink posted;
 *  - the MAIN phase feeds that exact message to a real `DbHostClient` over its
 *    `fork` seam and asserts the initialised transport received the event.
 *
 * Nothing in the child phase can reach the main phase's transport except through
 * that message. Delete the relay and the child phase captures nothing, so every
 * assertion below fails — which is what the previous test could not do.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  DbHostResponseKind,
  type DbHostTelemetryResponse,
} from "../src/main/database/db-host/db-host-protocol.js";
import { createDbHostTelemetryRelaySink } from "../src/main/database/db-host/db-host-telemetry-relay.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { DB_HOST_TELEMETRY_REFUSED_CATEGORY as REFUSED_CATEGORY } from "../src/main/telemetry/db-host-telemetry-refusal.js";
import { Observability } from "../src/main/telemetry/observability.js";
import {
  CollectorRecordsDroppedReason,
  DbHostTelemetryRefusalReason,
  type TelemetryEventPayload,
} from "../src/main/telemetry/telemetry-protocol.js";
import { setTelemetryRelaySink } from "../src/main/telemetry/telemetry-relay-sink.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import { deliverChildMessages } from "./db-host-fake-child-support.js";

const tempDirs: string[] = [];
let previousClaudeHome: string | undefined;

afterEach(async () => {
  // All three are process-global. A leaked sink would route a later suite's
  // main-side emit into this suite's capture array; a leaked transport would let
  // the child phase of a later run emit locally and hide a regression.
  setTelemetryRelaySink(null);
  Observability.reset();
  if (previousClaudeHome === undefined) {
    Reflect.deleteProperty(process.env, "CLAUDE_HOME");
  } else {
    process.env.CLAUDE_HOME = previousClaudeHome;
  }
  previousClaudeHome = undefined;
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** Finite, and ~54 million years past the ±8.64e15 ms range `Date` can hold. */
const NANOSECOND_EPOCH = 1_720_000_000_000_000_000;

const SESSION_ID = "iss7109-relay";
const SUBAGENT_ID = "agent-relay_1";

/** Hoisted per Ultracite `useTopLevelRegex`. */
const RELAY_DROP_LOG_RE = /db-host telemetry relay: dropped a child event/;
const RELAY_POST_FAILURE_RE = /could not post a collector\.records_dropped/;
const DROPPED_TWO_RECORDS_RE = /dropped 2 tool-use record\(s\)/;

/** The shape `reportCollectorRecordsDropped` hands the sink. */
const SAMPLE_EVENT: TelemetryEventPayload = {
  severity: "error",
  category: "collector.records_dropped",
  message: "Collector dropped 2 record(s) it had already read.",
  trace: {},
  diagnostics: {
    collectorRecordsDropped: {
      reason: CollectorRecordsDroppedReason.UnreadableTimestamp,
      count: 2,
    },
  },
};

/**
 * What `postMessage` throws on a value structured clone cannot carry. Named so
 * the fixture is the real failure rather than a generic `Error` standing in for
 * one — `DOMException` is not available in this runtime.
 */
class DataCloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataCloneError";
  }
}

/** A temp dir plus the `CLAUDE_HOME` capture, both torn down in `afterEach`. */
async function makeRunDir(prefix: string): Promise<string> {
  previousClaudeHome = process.env.CLAUDE_HOME;
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type ChildRun = {
  /** Every message the production relay sink handed to `post`. */
  posted: DbHostTelemetryResponse[];
  /** The child's local log lines (`deps.log`, which never leaves the machine). */
  logs: string[];
  /** The internal agent row id, so the local half can be asserted by value. */
  agentId: string | undefined;
  subagentsDir: string;
};

/**
 * Run the drop-producing path exactly as the DB-host child runs it: no
 * `Observability.init`, and the real relay sink installed the way
 * `db-host-worker.ts` installs it.
 *
 * `Observability` is deliberately left UNINITIALISED for the whole of this
 * function. That is not test hygiene, it is the fixture: it is what makes a
 * captured message the ONLY way an event can have escaped this process, and it
 * is the production state that made the emit a no-op in the first place.
 */
async function runDropInChildProcessConditions(
  dir: string,
  relayInstalled: boolean
): Promise<ChildRun> {
  const claudeHome = path.join(dir, "claude-home");
  process.env.CLAUDE_HOME = claudeHome;
  const projectDir = path.join(claudeHome, "projects", "claude-project");
  const subagentsDir = path.join(projectDir, SESSION_ID, "subagents");
  const parentTranscript = path.join(projectDir, `${SESSION_ID}.jsonl`);
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(parentTranscript, "{}\n", "utf8");
  const toolUseBlock = (id: string, name: string) => ({
    type: "tool_use",
    id,
    name,
    input: { file_path: `src/${id}.ts` },
  });
  await writeFile(
    path.join(subagentsDir, `${SUBAGENT_ID}.jsonl`),
    `${[
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-07T12:01:00.000Z",
        message: { content: [toolUseBlock("toolu_ok", "Read")] },
      }),
      // One unreadable entry stamp, two blocks under it — so the reported count
      // is 2, and an event that said 1 would mean only one was recognised.
      JSON.stringify({
        type: "assistant",
        timestamp: NANOSECOND_EPOCH,
        message: {
          content: [
            toolUseBlock("toolu_bad_a", "Bash"),
            toolUseBlock("toolu_bad_b", "Grep"),
          ],
        },
      }),
    ].join("\n")}\n`,
    "utf8"
  );

  const posted: DbHostTelemetryResponse[] = [];
  const logs: string[] = [];
  if (relayInstalled) {
    setTelemetryRelaySink(
      createDbHostTelemetryRelaySink({
        post: (message) => posted.push(message),
        log: (message) => logs.push(message),
      })
    );
  }

  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    emit: () => {
      // The renderer nudge is not what this suite is about.
    },
    log: (message: string) => logs.push(message),
    now: () => "2026-06-07T12:00:00.000Z",
  });
  try {
    await db.processEvent(
      "SessionStart",
      { session_id: SESSION_ID, cwd: path.join(dir, "workspace") },
      "claude"
    );
    await db.processEvent(
      "PreToolUse",
      {
        session_id: SESSION_ID,
        tool_name: "Task",
        tool_input: {
          subagent_type: "engineer",
          description: "Relay an unreadable stamp",
          prompt: "scan it",
          agent_id: SUBAGENT_ID,
        },
      },
      "claude"
    );
    await db.processEvent(
      "SubagentStop",
      {
        session_id: SESSION_ID,
        tool_name: "Task",
        transcript_path: parentTranscript,
      },
      "claude"
    );
    const agents = await db.agents.getBySession(SESSION_ID);
    return {
      posted,
      logs,
      agentId: agents.find((agent) => agent.subagentType === "engineer")?.id,
      subagentsDir,
    };
  } finally {
    await db.close();
  }
}

/**
 * Deliver `messages` to a real `DbHostClient` the way the forked child does, and
 * return everything the initialised transport received.
 *
 * The client is the production main-side handler, reached through its own
 * `fork` seam — so this asserts the shipped `handleMessage`, not a re-statement
 * of it. `Observability.init` runs HERE and nowhere else, mirroring the single
 * production composition root.
 */
function deliverToMain(messages: unknown[]): {
  telemetry: EnrichedTelemetryEvent[];
  logs: string[];
} {
  const telemetry: EnrichedTelemetryEvent[] = [];
  const logs: string[] = [];
  // In production the two phases are two OS processes and main simply has no
  // relay installed. One test process has to say so: leaving the child's sink in
  // place would send main's re-emit straight back into the child's capture array
  // instead of onto the transport.
  setTelemetryRelaySink(null);
  Observability.init({ telemetrySend: (event) => telemetry.push(event) });
  deliverChildMessages(messages, (message) => logs.push(message));
  return { telemetry, logs };
}

/**
 * THE ticket. The event originates in child-process conditions, crosses as a
 * message, and arrives on main's transport carrying the same bounded reason and
 * count the collector reported — and nothing else.
 */
test("a drop event raised in db-host-child conditions reaches main's monitored transport", async () => {
  const dir = await makeRunDir("iss7109-relay-");

  const child = await runDropInChildProcessConditions(dir, true);

  // The crossing itself. Exactly one DROP message, because the hook reports once
  // per hook rather than once per sidecar.
  //
  // Counted by category rather than over every message the relay carried: since
  // ISS-6339 the same child also raises `store.migration.step` while opening the
  // store, so a bare `posted.length` no longer describes this event at all. The
  // once-per-hook property being asserted is unchanged.
  const dropCrossings = child.posted.filter(
    (message) =>
      message.kind === DbHostResponseKind.Telemetry &&
      message.event.category === "collector.records_dropped"
  );
  assert.equal(dropCrossings.length, 1);
  const crossing = dropCrossings[0];
  assert.equal(crossing?.kind, DbHostResponseKind.Telemetry);
  assert.equal(crossing?.event.category, "collector.records_dropped");

  // The relay never swallows the actionable local half: the session, agent row,
  // and sidecar path stay on this machine's log, and must not have been traded
  // for the fleet-wide event.
  const localReport = child.logs.find((message) =>
    message.includes("unreadable timestamp")
  );
  assert.ok(localReport, `no local report in: ${JSON.stringify(child.logs)}`);
  assert.ok(child.agentId);
  assert.ok(localReport.includes(`agent=${child.agentId}`));

  // Now main, with the ONLY initialised transport in the test, receiving the
  // verbatim message. Sent through `structuredClone` first because that is what
  // `postMessage` does to it — an event that cannot survive the boundary is a
  // drop, and asserting on the in-process object would hide it.
  const postedBeforeDelivery = child.posted.length;
  const delivered = deliverToMain([structuredClone(crossing)]);
  const dropped = delivered.telemetry.filter(
    (event) => event.category === "collector.records_dropped"
  );
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]?.severity, "error");
  assert.deepEqual(dropped[0]?.diagnostics?.collectorRecordsDropped, {
    reason: CollectorRecordsDroppedReason.UnreadableTimestamp,
    count: 2,
  });
  // The split ISS-6417 built still holds across the new hop: the fleet-wide
  // event carries no transcript path and no session id.
  const emitted = JSON.stringify(dropped[0]);
  assert.ok(!emitted.includes(child.subagentsDir));
  assert.ok(!emitted.includes(SESSION_ID));

  // Main's re-emit went to the transport, not back around the relay. Compared
  // against the count taken before delivery rather than a literal, because the
  // child now legitimately relays other events too (ISS-6339) and the literal
  // was arithmetic about THOSE, not about looping.
  //
  // Read as a weak check, not a counterfactual: `deliverToMain` clears the relay
  // sink before it delivers anything, so `child.posted` cannot grow during it
  // whether or not main's re-emit loops. Proving the no-loop property needs a
  // delivery with the sink still installed, which this helper does not do — a
  // pre-existing gap this change neither introduces nor closes.
  assert.equal(child.posted.length, postedBeforeDelivery);
});

/**
 * The relay is ADDITIVE. ISS-6417 split this signal into a monitored half and a
 * LOCAL half — the session, agent row, and sidecar path an operator on that
 * machine can act on — and the local half was never the broken part. Running the
 * identical drop with no relay installed pins that: the log line is byte-for-byte
 * what it was before this change, so the fix bought the fleet-wide event without
 * spending the on-machine detail.
 *
 * This asserts the local half only, on purpose. An `assert.deepEqual(posted, [])`
 * here would look like a counterfactual and be a tautology: with no relay
 * installed nothing holds a reference to that array, so it is empty by
 * construction and no production change could ever make it otherwise. The real
 * counterfactual for the relay is the test below, which does execute it.
 */
test("the ISS-6417 local half is unchanged by the relay", async () => {
  const dir = await makeRunDir("iss7109-norelay-");

  const child = await runDropInChildProcessConditions(dir, false);

  assert.ok(child.agentId);
  const localReport = child.logs.find((message) =>
    message.includes("unreadable timestamp")
  );
  assert.ok(localReport, `no local report in: ${JSON.stringify(child.logs)}`);
  assert.match(localReport, DROPPED_TWO_RECORDS_RE);
  assert.ok(localReport.includes(`agent=${child.agentId}`));
  assert.ok(localReport.includes(`session=${SESSION_ID}`));
});

/**
 * The executable counterfactual for the chokepoint, and the reason this fix is
 * one edit rather than twenty.
 *
 * `Observability` has exactly two emit points — `getTelemetryEmitter().emit` and
 * the private `emitTelemetry` every named reporter funnels through — and both now
 * consult the relay FIRST. With a sink installed AND a transport initialised, the
 * event must go to the sink and NOT to the local transport: that is the child's
 * situation with the null transport made observable. Revert `deliverTelemetry` to
 * the old `Observability.telemetry?.emit(event)` and both halves fail, because
 * the event lands in `transport` instead.
 *
 * The second half uses `tokenCostPricingMiss`, deliberately: it is raised from
 * `database/token-cost-writes.ts` and `database/session-trace.ts`, both of which
 * execute IN THE CHILD, so `token_cost.pricing_miss` was being discarded by the
 * same null transport and is carried out by the same chokepoint.
 */
test("both Observability emit points prefer the installed relay over the local transport", () => {
  const relayed: TelemetryEventPayload[] = [];
  const transport: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => transport.push(event) });
  setTelemetryRelaySink((event) => relayed.push(event));

  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: "collector.records_dropped",
    message: "raised through the public emitter",
    diagnostics: {
      collectorRecordsDropped: {
        reason: CollectorRecordsDroppedReason.UnreadableTimestamp,
        count: 1,
      },
    },
  });
  Observability.tokenCostPricingMiss({
    model: "iss7109-unpriced",
    surface: "trace_activity",
    resolveReason: () => "no_match",
  });

  assert.deepEqual(
    relayed.map((event) => event.category),
    ["collector.records_dropped", "token_cost.pricing_miss"]
  );
  assert.deepEqual(
    transport,
    [],
    "an emit that reached the local transport never left the child"
  );
});

/**
 * The sink's contract is "never throws", and it is load-bearing rather than
 * decorative. `reportCollectorRecordsDropped` is called from `live-hook.ts`
 * AFTER the hook's transaction has committed — an exception escaping the sink
 * there would propagate out of the invoke dispatch and report a durably-written
 * hook as a FAILED op, turning a lost telemetry event into lost data.
 *
 * Both rungs are covered, because the second is the one that bites: the sink's
 * own recovery is `childLog`, which posts down the SAME parentPort that just
 * failed, so on a torn-down channel the catch block's report throws too.
 */
test("the sink absorbs a failed post, and a failed post whose own report also fails", () => {
  const logs: string[] = [];
  const postFails = createDbHostTelemetryRelaySink({
    post: () => {
      throw new DataCloneError("could not be cloned");
    },
    log: (message) => logs.push(message),
  });
  postFails(SAMPLE_EVENT);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", RELAY_POST_FAILURE_RE);

  const bothFail = createDbHostTelemetryRelaySink({
    post: () => {
      throw new DataCloneError("could not be cloned");
    },
    log: () => {
      throw new Error("parentPort is gone");
    },
  });
  // The assertion is that this line returns at all.
  bothFail(SAMPLE_EVENT);
});

/**
 * The boundary must not become the drop. A newer child may emit a category this
 * build has never compiled against and diagnostics fields it has never seen; the
 * validator checks the three fields the transport routes by and lets the rest
 * ride, so that signal reaches the fleet instead of dying at an over-strict
 * guard. Adjudicating an unknown category is the server schema's job, and it
 * says so out loud (`telemetry.validation_failed`) rather than in silence.
 */
test("a newer child's unknown category and extra diagnostics still cross", () => {
  const delivered = deliverToMain([
    {
      kind: DbHostResponseKind.Telemetry,
      event: {
        severity: "warn",
        category: "collector.quarantine_swept",
        message: "a category this build has never heard of",
        diagnostics: { extra: { sweptRows: 4, unknownFutureField: true } },
      },
    },
  ]);

  assert.equal(delivered.telemetry.length, 1);
  assert.equal(delivered.telemetry[0]?.category, "collector.quarantine_swept");
  assert.deepEqual(delivered.telemetry[0]?.diagnostics?.extra, {
    sweptRows: 4,
    unknownFutureField: true,
  });
  assert.deepEqual(
    delivered.logs.filter((message) => RELAY_DROP_LOG_RE.test(message)),
    []
  );
});

/**
 * Cross-repo / version skew, both directions.
 *
 * A response kind an installed build has never heard of must be ignored, not
 * crash the client and not be mistaken for telemetry — a newer child is allowed
 * to speak first. A message that DOES claim to be telemetry but carries an
 * unroutable payload is the one case that must not pass in silence: it is
 * refused at the boundary AND stated on the local log, because a telemetry drop
 * that nobody can see is the defect this whole route exists to end.
 *
 * ISS-7201 changed what "out loud" means, so the telemetry assertion below
 * changed with it: the refusal is now ALSO a monitored event, not a local log
 * line only. The log expectations are unchanged and still pinned.
 */
test("an unknown response kind is ignored, and a malformed telemetry payload is refused out loud", () => {
  const delivered = deliverToMain([
    { kind: "collector-quarantine-report", count: 3 },
    { kind: DbHostResponseKind.Telemetry, event: { message: "no severity" } },
    { kind: DbHostResponseKind.Telemetry },
  ]);

  // Two refusals reach the monitored transport, and nothing else does. NOT
  // three — the unknown kind is a newer peer's business and emits nothing.
  assert.deepEqual(
    delivered.telemetry.map((event) => event.category),
    [REFUSED_CATEGORY, REFUSED_CATEGORY]
  );
  const refusals = delivered.logs.filter((message) =>
    RELAY_DROP_LOG_RE.test(message)
  );
  // Two: the malformed payload and the missing one. NOT three — the unknown
  // kind is a newer peer's business and gets no log line at all.
  assert.equal(refusals.length, 2);
});

/**
 * ISS-7201, THE ticket: a refusal at main's boundary reaches the monitored sink.
 *
 * ISS-7109 routed the CHILD's events to main's transport but left main's own
 * refusal branch on a local log line — so a child emitting something main cannot
 * validate produced no monitored signal, which reads identically to a healthy
 * child with nothing to report. Revert `reportRefusedChildTelemetry`'s emit and
 * this test fails on an empty `telemetry` array.
 */
test("a refused child telemetry event reaches the monitored transport with its reason", () => {
  const delivered = deliverToMain([
    { kind: DbHostResponseKind.Telemetry, event: { message: "no severity" } },
  ]);

  assert.equal(delivered.telemetry.length, 1);
  const [event] = delivered.telemetry;
  assert.equal(event.category, REFUSED_CATEGORY);
  assert.equal(event.severity, "error");
  assert.equal(
    event.diagnostics?.dbHostTelemetryRefused?.reason,
    DbHostTelemetryRefusalReason.InvalidSeverity
  );
});

/**
 * The counterfactual half of the test above, and the one the operator asked for
 * by name: a WELL-FORMED event must not emit a refusal. Without this, a producer
 * that reported a refusal unconditionally would still pass the assertion above
 * while inflating the very alert being built on it.
 */
test("a well-formed child telemetry event is relayed and emits no refusal", () => {
  const delivered = deliverToMain([
    { kind: DbHostResponseKind.Telemetry, event: SAMPLE_EVENT },
  ]);

  assert.deepEqual(
    delivered.telemetry.map((event) => event.category),
    [SAMPLE_EVENT.category]
  );
  assert.equal(
    delivered.telemetry.filter((event) => event.category === REFUSED_CATEGORY)
      .length,
    0
  );
  assert.deepEqual(
    delivered.logs.filter((message) => RELAY_DROP_LOG_RE.test(message)),
    []
  );
});

/**
 * Each fault maps to the reason that actually caused the drop, first-fault-only,
 * AND every reason the enum declares is one a real refusal can actually produce.
 *
 * Two failures are in scope. A classifier that collapsed these onto one generic
 * reason would keep the ticket's assertion green while making the monitor's
 * `reason` grouping useless, so the mapping is pinned per case. And an
 * UNEMITTABLE member — one no input can produce — is worse than useless on a
 * monitored dimension: it gives a dashboard a bucket that is silently always
 * zero. The coverage assertion at the end is what makes adding one fail here
 * instead of in Datadog, and it is why `unknown_shape` may only exist while the
 * `logTail` case below actually produces it.
 */
test("each unroutable field is reported as its own bounded reason", () => {
  const cases: [unknown, string][] = [
    [undefined, DbHostTelemetryRefusalReason.NotAnObject],
    ["a string", DbHostTelemetryRefusalReason.NotAnObject],
    [
      { severity: "critical", category: "c", message: "m" },
      DbHostTelemetryRefusalReason.InvalidSeverity,
    ],
    [
      { severity: "error", category: "", message: "m" },
      DbHostTelemetryRefusalReason.MissingCategory,
    ],
    [
      { severity: "error", category: "c", message: 42 },
      DbHostTelemetryRefusalReason.MissingMessage,
    ],
    [
      {
        severity: "error",
        category: "c",
        message: "m",
        diagnostics: { logTail: {} },
      },
      DbHostTelemetryRefusalReason.UnknownShape,
    ],
  ];

  const produced = new Set<string>();
  for (const [event, expected] of cases) {
    const delivered = deliverToMain([
      { kind: DbHostResponseKind.Telemetry, event },
    ]);
    assert.equal(delivered.telemetry.length, 1);
    const reason = delivered.telemetry[0].diagnostics?.dbHostTelemetryRefused
      ?.reason as string | undefined;
    assert.equal(reason, expected);
    if (reason !== undefined) {
      produced.add(reason);
    }
  }

  assert.deepEqual(
    [...produced].sort(),
    [...Object.values(DbHostTelemetryRefusalReason)].sort()
  );
});

/**
 * ISS-7201 review follow-up — the false-completeness hole in the boundary check.
 *
 * The predicate used to claim a whole `TelemetryEventPayload` after checking
 * three fields, so `diagnostics.logTail: {}` — an object, and perfectly
 * structured-clone-safe, so the relay carries it across intact — passed as
 * routable. Main then reached `TelemetryService.enrichEvent`, which does
 * `Buffer.from(logTail, "utf8")` and THROWS on an object; `emit()` swallows
 * every throw by contract. The result was double silence: the child's event was
 * lost AND the refusal that should have reported the loss never fired, which is
 * precisely the fleet-level blindness ISS-7201 exists to end.
 *
 * So the assertion that matters is not "it is refused" but "SOMETHING reaches
 * the monitored transport". Delete the diagnostics arm of the classifier and
 * `telemetry` comes back empty, not wrong.
 */
test("a mistyped known diagnostics field is refused as unknown_shape instead of vanishing in enrichEvent", () => {
  const delivered = deliverToMain([
    {
      kind: DbHostResponseKind.Telemetry,
      event: {
        severity: "error",
        category: "collector.records_dropped",
        message: "a child event whose logTail is an object, not a string",
        diagnostics: { logTail: {} },
      },
    },
  ]);

  // Exactly one event, and it is the refusal — the child's own event is still
  // lost (its diagnostics are unroutable), but the loss is now COUNTED.
  assert.equal(delivered.telemetry.length, 1);
  const [event] = delivered.telemetry;
  assert.equal(event.category, REFUSED_CATEGORY);
  assert.equal(event.severity, "error");
  assert.equal(
    event.diagnostics?.dbHostTelemetryRefused?.reason,
    DbHostTelemetryRefusalReason.UnknownShape
  );
  assert.equal(
    delivered.logs.filter((message) => RELAY_DROP_LOG_RE.test(message)).length,
    1
  );
});

/**
 * The counterfactual for the case above, and the reason the boundary schema is
 * LOOSE rather than strict.
 *
 * A newer child may attach diagnostics keys this build has never heard of. Those
 * must ride through untouched — a strict schema would reject the whole payload
 * over one unknown key and manufacture exactly the silent drop the arm above was
 * added to end. Only a KNOWN field of the wrong type is `unknown_shape`.
 */
test("an unknown diagnostics key rides through beside a well-formed known one", () => {
  const delivered = deliverToMain([
    {
      kind: DbHostResponseKind.Telemetry,
      event: {
        severity: "warn",
        category: "collector.records_dropped",
        message: "a newer child's diagnostics",
        diagnostics: {
          logTail: "a genuine string tail",
          somethingThisBuildHasNeverHeardOf: { nested: true },
        },
      },
    },
  ]);

  assert.deepEqual(
    delivered.telemetry.map((relayed) => relayed.category),
    ["collector.records_dropped"]
  );
  assert.equal(
    delivered.telemetry[0]?.diagnostics?.logTail,
    "a genuine string tail"
  );
  assert.deepEqual(
    delivered.logs.filter((message) => RELAY_DROP_LOG_RE.test(message)),
    []
  );
});

/**
 * IDS, SIZES, CLOSED ENUMS — NEVER CONTENT.
 *
 * The refused event's content is precisely what failed validation, so none of it
 * may ride the refusal out. This fails the moment someone "helpfully" attaches
 * the offending category or message to make the alert more debuggable.
 */
test("a refusal carries no content from the event it refused", () => {
  const secret = "transcript-text-that-must-not-travel";
  const delivered = deliverToMain([
    {
      kind: DbHostResponseKind.Telemetry,
      event: { severity: "nope", category: secret, message: secret },
    },
  ]);

  assert.equal(delivered.telemetry.length, 1);
  const serialized = JSON.stringify(delivered.telemetry[0]);
  assert.equal(serialized.includes(secret), false);
  // The diagnostics bag carries the bounded reason and nothing else.
  assert.deepEqual(delivered.telemetry[0].diagnostics?.dbHostTelemetryRefused, {
    reason: DbHostTelemetryRefusalReason.InvalidSeverity,
  });
});
