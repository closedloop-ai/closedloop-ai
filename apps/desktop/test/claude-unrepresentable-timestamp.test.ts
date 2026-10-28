/**
 * @file claude-unrepresentable-timestamp.test.ts
 * @description ISS-6417 — a sidecar line whose numeric `timestamp` no `Date` can
 * represent costs that ONE line's stamp, never the rest of the file.
 *
 * `subagent-scanner.ts` carried its own `normalizeTimestamp`, a copy of the
 * canonical `toIso` that had lost its unrepresentable-number guard.
 * `new Date(n).toISOString()` throws `RangeError` for a nanosecond epoch, for
 * `NaN`, and for the `Infinity` that `JSON.parse` yields from an overflowing
 * numeric literal — all three reachable, because a transcript file is a parse
 * boundary and nothing upstream constrains that field.
 *
 * Thrown from `extractToolUses`, that exception escaped the per-line loop
 * around it, so the live-hook `SubagentStop` catch dropped every tool-use
 * record for the sidecar — including the ones already read off earlier lines.
 * What the guard restores in production is therefore those OTHER records: the
 * one unreadable stamp still yields no `PostToolUse` event, because
 * `live-hook.ts` will not place an event it has no time for, and inventing one
 * would be the worse answer.
 *
 * Each case asserts the surviving records by exact value, not that the call
 * returned: a reader that swallowed the file and answered empty satisfies "did
 * not throw" and is the defect itself.
 *
 * The last case is the boot importer, which reaches these files through its own
 * `agentToolUses` and has read stamps through the guarded `toIso` since the
 * ISS-6531 parser rewrite. It is pinned rather than fixed here: `agentToolUses`
 * is the reader ISS-6480 is queued to change, and nothing until now would have
 * caught that change re-widening one bad stamp into the whole sidecar's tokens.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { parseSessionFile } from "../src/main/collectors/claude/claude-parser.js";
import { scanSubagentTranscriptStream } from "../src/main/collectors/parsing/subagent-scanner.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { extractTranscriptTokens } from "../src/main/database/transcript.js";
import { reportCollectorRecordsDropped } from "../src/main/telemetry/collector-records-dropped-telemetry.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { CollectorRecordsDroppedReason } from "../src/main/telemetry/telemetry-protocol.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import {
  cleanupTempDirs,
  makeTempDir,
  writeClaudeTranscript,
} from "./normalized-session-test-utils.js";
import {
  assistantLine,
  DELEGATING_ONLY_PARENT,
  editBlock,
  INPUT_TOKENS_PER_TURN,
  MODEL,
  OUTPUT_TOKENS_PER_TURN,
} from "./sidecar-diff-stats-fixtures.js";

afterEach(cleanupTempDirs);
afterEach(() => {
  Observability.reset();
});

/**
 * A nanosecond epoch: finite, and ~54 million years past the ±8.64e15 ms
 * (~273,790 year) range `Date` can hold.
 */
const NANOSECOND_EPOCH = 1_720_000_000_000_000_000;

/**
 * Written as raw text, not through `JSON.stringify`: `1e999` is a legal JSON
 * number that `JSON.parse` resolves to `Infinity`, and no serializer round-trip
 * can produce it. This is the shape that proves the bad value arrives from DISK
 * rather than from a test constructing an impossible in-process value.
 */
const OVERFLOWING_LITERAL_LINE =
  '{"type":"tool_use","id":"toolu_inf","name":"Grep","timestamp":1e999}';

/** Hoisted per Ultracite `useTopLevelRegex`. The COUNT is the load-bearing part. */
const DROPPED_TWO_RECORDS_RE = /dropped 2 tool-use record\(s\)/;

/** A sidecar whose MIDDLE lines carry stamps no `Date` can represent. */
function sidecarWithUnrepresentableStamps(): string {
  const filePath = path.join(makeTempDir("iss6417-"), "agent-lane.jsonl");
  writeFileSync(
    filePath,
    `${[
      JSON.stringify({
        type: "tool_use",
        id: "toolu_first",
        name: "Read",
        timestamp: "2026-08-06T10:00:01.000Z",
        input: { file_path: "/test/first.ts" },
      }),
      JSON.stringify({
        type: "tool_use",
        id: "toolu_nanos",
        name: "Bash",
        timestamp: NANOSECOND_EPOCH,
        input: { command: "ls" },
      }),
      OVERFLOWING_LITERAL_LINE,
      JSON.stringify({
        type: "tool_use",
        id: "toolu_last",
        name: "Write",
        timestamp: "2026-08-06T10:00:09.000Z",
        input: { file_path: "/test/last.ts" },
      }),
    ].join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

test("a sidecar's readable tool uses survive an unrepresentable stamp beside them", async () => {
  const filePath = sidecarWithUnrepresentableStamps();

  const result = await scanSubagentTranscriptStream(
    filePath,
    "ses-1",
    "agent-lane"
  );

  // `toolu_last` is the positive control: it sits AFTER both bad lines, so its
  // presence is what proves the scan resumed rather than abandoning the file.
  // `toolu_first` proves the prefix already read was not thrown away with it.
  // The two bad lines report an unknown time rather than a made-up one.
  assert.deepEqual(
    result.toolUses.map((toolUse) => ({
      toolUseId: toolUse.toolUseId,
      toolName: toolUse.toolName,
      timestamp: toolUse.timestamp,
    })),
    [
      {
        toolUseId: "toolu_first",
        toolName: "Read",
        timestamp: "2026-08-06T10:00:01.000Z",
      },
      { toolUseId: "toolu_nanos", toolName: "Bash", timestamp: null },
      { toolUseId: "toolu_inf", toolName: "Grep", timestamp: null },
      {
        toolUseId: "toolu_last",
        toolName: "Write",
        timestamp: "2026-08-06T10:00:09.000Z",
      },
    ]
  );
});

test("the boot importer keeps a sidecar's tokens and diffs past an unrepresentable stamp", async () => {
  const parentFile = writeClaudeTranscript(
    "ses-iss6417",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine("u_a", "req_a", "msg_a", [
            editBlock("toolu_a", "/test/a.ts"),
          ]),
          {
            type: "tool_use",
            id: "toolu_nanos",
            name: "Bash",
            timestamp: NANOSECOND_EPOCH,
            input: { command: "ls" },
          },
          assistantLine("u_b", "req_b", "msg_b", [
            editBlock("toolu_b", "/test/b.ts"),
          ]),
        ],
      },
    }
  );

  const parsed = await parseSessionFile(parentFile);

  // The parent turn plus BOTH sidecar turns. Two turns would mean the parent and
  // one sidecar turn; one would mean the sidecar was dropped whole.
  assert.deepEqual(parsed?.tokensByModel?.[MODEL], {
    input: 3 * INPUT_TOKENS_PER_TURN,
    output: 3 * OUTPUT_TOKENS_PER_TURN,
    cacheRead: 0,
    cacheWrite: 0,
  });
  // Both `Edit` blocks: `beta\ngamma` replacing `alpha` is +2/-1 per file.
  assert.deepEqual(parsed?.diffStats, {
    filesChanged: 2,
    linesAdded: 4,
    linesRemoved: 2,
  });
  assert.deepEqual(
    parsed?.subagents?.[0]?.toolUses?.map((toolUse) => toolUse.name),
    ["Edit", "Bash", "Edit"]
  );
});

/**
 * ISS-6417 (review, tamsinb): `database/transcript.ts` carried the SAME
 * unguarded `normalizeTimestamp` copy, and the collectors AGENTS.md names this
 * hazard by hand — "Two readers parse the Claude transcript, and they drift."
 * That reader stamps two lines: one carrying `isApiErrorMessage`, one carrying a
 * model + usage. Either one holding a nanosecond epoch threw out of
 * `processLinesIntoMap`, and NOTHING between there and the caller catches it, so
 * `extractTranscriptTokens` never returned — the whole file's tokens were lost
 * to one bad stamp on one line.
 */
const UNREADABLE_STAMP_TRANSCRIPT_MODEL = "claude-sonnet-4-5-20260929";

/**
 * Both throwing shapes, each between readable lines. The bad stamps sit in the
 * MIDDLE so the trailing line is a positive control: it can only be counted if
 * the reader resumed instead of abandoning the file.
 */
function transcriptWithUnrepresentableStamps(): string {
  const filePath = path.join(makeTempDir("iss6417-tokens-"), "session.jsonl");
  const usage = (input: number, output: number) => ({
    input_tokens: input,
    output_tokens: output,
  });
  writeFileSync(
    filePath,
    `${[
      JSON.stringify({
        type: "assistant",
        uuid: "u_first",
        requestId: "req_first",
        timestamp: "2026-08-06T10:00:01.000Z",
        message: {
          id: "msg_first",
          model: UNREADABLE_STAMP_TRANSCRIPT_MODEL,
          usage: usage(10, 5),
        },
      }),
      // The `isApiErrorMessage` branch — stamped, and never model-bearing.
      JSON.stringify({
        isApiErrorMessage: true,
        uuid: "u_error",
        timestamp: NANOSECOND_EPOCH,
        message: { type: "error", error: { message: "overloaded" } },
      }),
      // The model + usage branch, carrying the same unreadable stamp.
      JSON.stringify({
        type: "assistant",
        uuid: "u_nanos",
        requestId: "req_nanos",
        timestamp: NANOSECOND_EPOCH,
        message: {
          id: "msg_nanos",
          model: UNREADABLE_STAMP_TRANSCRIPT_MODEL,
          usage: usage(100, 50),
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "u_last",
        requestId: "req_last",
        timestamp: "2026-08-06T10:00:09.000Z",
        message: {
          id: "msg_last",
          model: UNREADABLE_STAMP_TRANSCRIPT_MODEL,
          usage: usage(1, 2),
        },
      }),
    ].join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

test("the token reader keeps a transcript's usage past an unrepresentable stamp", () => {
  const filePath = transcriptWithUnrepresentableStamps();

  const extract = extractTranscriptTokens(filePath);

  // Asserted by exact totals, not by "did not throw": a reader that swallowed
  // the file and answered empty also does not throw, and is the defect itself.
  // 111/57 is all THREE usage lines — dropping the unreadably-stamped one would
  // give 11/7, and abandoning the file at it would give 10/5.
  assert.deepEqual(
    extract?.tokensByModel.get(UNREADABLE_STAMP_TRANSCRIPT_MODEL),
    {
      input: 111,
      output: 57,
      cacheRead: 0,
      cacheWrite: 0,
    }
  );
  assert.equal(extract?.latestModel, UNREADABLE_STAMP_TRANSCRIPT_MODEL);
  // Two records, not three: the unreadably-stamped line's TOKENS count toward
  // the model total above, but `buildUsageTokenRecord` emits no `token_event`
  // for it, because a timestamped event needs a time and inventing one would be
  // the worse answer. Same principle the sidecar case documents.
  assert.deepEqual(
    extract?.records.map((record) => record.timestamp),
    ["2026-08-06T10:00:01.000Z", "2026-08-06T10:00:09.000Z"]
  );
});

/**
 * ISS-6417 (review, davetho): keeping the sidecar alive is not the whole
 * guardrail. A record whose stamp `toIso` could not read comes back with a null
 * timestamp, and the `SubagentStop` loop inserts only records that have one — so
 * the record IS still dropped, just non-fatally. The bad-data rule says a
 * degraded input is reported to a monitor, never silently coerced away.
 *
 * Reported AFTER the commit — the same post-commit contract ISS-5429 established
 * for the stale-sweep count, because reporting from inside the open transaction
 * announces rows a later failing statement rolls back — and in two halves, which
 * is what this test pins:
 *
 *  1. The MONITORED half. `deps.log` reaches `gatewayLog.info` and never leaves
 *     the machine, so the only assertion that proves the signal is reportable at
 *     all is the emitted telemetry EVENT: its category is the facet a Datadog
 *     monitor keys on, and its typed diagnostics are what such a monitor groups
 *     by. Asserting the log line alone (the first cut of this test) cannot fail
 *     when the telemetry emit is deleted.
 *  2. The LOCAL half, which stays a log line on purpose: the session, agent row,
 *     and sidecar path are the actionable detail for an operator on that
 *     machine, and are exactly what must NOT ride a fleet-wide event.
 */
test("an unreadable sidecar stamp is reported to the monitored path, not silently dropped", async () => {
  const previousClaudeHome = process.env.CLAUDE_HOME;
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6417-report-"));
  const claudeHome = path.join(dir, "claude-home");
  process.env.CLAUDE_HOME = claudeHome;
  const projectDir = path.join(claudeHome, "projects", "claude-project");
  const subagentsDir = path.join(projectDir, "life-report", "subagents");
  const parentTranscript = path.join(projectDir, "life-report.jsonl");
  const subagentId = "agent-report_1";
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(parentTranscript, "{}\n", "utf8");
  const toolUseBlock = (id: string, name: string) => ({
    type: "tool_use",
    id,
    name,
    input: { file_path: `src/${id}.ts` },
  });
  await writeFile(
    path.join(subagentsDir, `${subagentId}.jsonl`),
    `${[
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-07T12:01:00.000Z",
        message: { content: [toolUseBlock("toolu_ok", "Read")] },
      }),
      // One entry stamp, so BOTH of its blocks become unplaceable — which is
      // what makes the reported count 2 rather than 1.
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

  const telemetry: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => telemetry.push(event) });
  const logs: string[] = [];
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    emit: () => {},
    log: (message: string) => logs.push(message),
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.processEvent(
      "SessionStart",
      { session_id: "life-report", cwd: path.join(dir, "workspace") },
      "claude"
    );
    await db.processEvent(
      "PreToolUse",
      {
        session_id: "life-report",
        tool_name: "Task",
        tool_input: {
          subagent_type: "engineer",
          description: "Report unreadable stamps",
          prompt: "scan it",
          agent_id: subagentId,
        },
      },
      "claude"
    );
    await db.processEvent(
      "SubagentStop",
      {
        session_id: "life-report",
        tool_name: "Task",
        transcript_path: parentTranscript,
      },
      "claude"
    );

    // The readable record still lands — the report is in ADDITION to the
    // isolation this PR fixed, not instead of it.
    const events = await db.events.getBySession("life-report");
    assert.deepEqual(
      events
        .filter((event) => event.eventType === "PostToolUse")
        .map((event) => event.toolName),
      ["Read"]
    );

    // The monitored half. The count is the assertion that matters: an event that
    // fired but said 1 would mean only one of the entry's two blocks was
    // recognized as dropped, and one that said 0 would be reporting a drop that
    // did not happen. Nothing else may ride it — a fleet-wide event carrying the
    // transcript path would be the leak this split exists to prevent.
    const dropped = telemetry.filter(
      (event) => event.category === "collector.records_dropped"
    );
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]?.severity, "error");
    assert.deepEqual(dropped[0]?.diagnostics?.collectorRecordsDropped, {
      reason: CollectorRecordsDroppedReason.UnreadableTimestamp,
      count: 2,
    });
    const emitted = JSON.stringify(dropped[0]);
    assert.ok(!emitted.includes(subagentsDir));
    assert.ok(!emitted.includes("life-report"));

    // The local half keeps the detail the monitored event deliberately drops.
    const report = logs.find((message) =>
      message.includes("unreadable timestamp")
    );
    assert.ok(report, `no unreadable-stamp report in: ${JSON.stringify(logs)}`);
    assert.match(report, DROPPED_TWO_RECORDS_RE);
    // The actionable details: which session, which agent row, and the sidecar
    // file to actually go look at. `agent=` carries the internal agent id, not
    // the harness-supplied name, which is the id the events are keyed by.
    const agents = await db.agents.getBySession("life-report");
    const subagent = agents.find((agent) => agent.subagentType === "engineer");
    assert.ok(subagent);
    assert.ok(report.includes(`agent=${subagent.id}`));
    assert.ok(report.includes("session=life-report"));
    assert.ok(report.includes(path.join(subagentsDir, `${subagentId}.jsonl`)));
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
    if (previousClaudeHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousClaudeHome;
    }
  }
});

/**
 * ISS-6417: the zero guard is not a defensive nicety, it is the common path.
 * `handleHook` reports a sidecar only when it dropped something, so the caller's
 * total is 0 on every healthy `SubagentStop` — without the guard the fleet would
 * see one drop event per hook, each of them describing a drop that never
 * happened and each rejected downstream as `telemetry.validation_failed`.
 */
test("a hook that dropped nothing emits no drop event", () => {
  const telemetry: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => telemetry.push(event) });

  reportCollectorRecordsDropped({
    reason: CollectorRecordsDroppedReason.UnreadableTimestamp,
    count: 0,
  });

  assert.deepEqual(telemetry, []);
});
