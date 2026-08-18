/**
 * @file parse-claude-rewrite-regressions.test.ts
 * @description The defects a full code review found in the parser rewrite, each
 * pinned by the behaviour that was wrong rather than by the shape of the fix.
 *
 * Every case here went green against a passing 337-test suite and a fully green
 * golden corpus, because the corpus happens to contain no transcript with an
 * inline-sidechain `Skill` call, no assistant-text command marker, and no empty
 * `service_tier`. That is the point: these assert the derivations directly, so
 * they do not depend on a corpus sample existing.
 */
import { describe, expect, it } from "vitest";
import { createSessionAccumulator } from "./parse-claude-accumulator";
import {
  parseClaudeTranscript,
  scanTranscriptLines,
} from "./parse-claude-core";
import { reportUnknownRecords } from "./parse-claude-drift";

const BASE_USAGE = { input_tokens: 10, output_tokens: 5 };

/** Distinct stamps so ordering assertions are not accidentally satisfied. */
const TIMESTAMPS = [
  "2026-07-09T12:00:01.000Z",
  "2026-07-09T12:00:02.000Z",
  "2026-07-09T12:00:03.000Z",
  "2026-07-09T12:00:04.000Z",
  "2026-07-09T12:00:05.000Z",
];

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "go" },
});

describe("skills are counted once per invocation", () => {
  it("does not double-count an inline-sidechain Skill call", async () => {
    // `recordToolUse` puts the SAME object into `accumulator.toolUses` and onto
    // the subagent's row, so folding both lists naively billed one invocation
    // twice — on the desktop importer and the shipped cloud renderer alike.
    const sidechainSkill = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      agentId: "ad00546980b4b4701",
      isSidechain: true,
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_skill_1",
            name: "Skill",
            input: { skill: "code-review" },
          },
        ],
        usage: BASE_USAGE,
      },
    });

    const session = await parseClaudeTranscript([USER_LINE, sidechainSkill], {
      sessionId: "skills-once",
    });

    expect(session?.skills.map((skill) => skill.name)).toEqual(["code-review"]);
  });

  it("still counts a subagent-only Skill call that the session never saw", async () => {
    // The paired control: the fold exists because an agent's own calls are NOT
    // in `session.toolUses`. Excluding by identity must not exclude those.
    const accumulator = createSessionAccumulator();
    await scanTranscriptLines([USER_LINE], accumulator);
    accumulator.subagents.set("agent-x", {
      id: "agent-x",
      parentId: null,
      name: "agent-x",
      startedAt: null,
      endedAt: null,
      status: "completed",
      nativeSubagentId: "agent-x",
      toolUses: [
        {
          name: "Skill",
          kind: "harness",
          skillName: "merged-only-skill",
          timestamp: "2026-07-09T12:00:02.000Z",
          subagentId: "agent-x",
        },
      ],
    });
    const { buildSession, deriveSessionUsage, ownDiffStats } = await import(
      "./parse-claude-core"
    );
    const session = buildSession(accumulator, {
      sessionId: "skills-merged",
      parseQuality: {
        totalLines: 1,
        malformedLines: 0,
        truncatedFinalLine: false,
      },
      usage: deriveSessionUsage(accumulator),
      diffStats: ownDiffStats(accumulator),
    });

    expect(session.skills.map((skill) => skill.name)).toEqual([
      "merged-only-skill",
    ]);
  });
});

describe("slash commands are scanned in both text lanes", () => {
  it("records a command marker written into ASSISTANT text", async () => {
    // The harness echoes the marker into assistant text on expansion/replay. A
    // rewrite that ported only the user lane dropped the row silently.
    const assistantCommand = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      uuid: "assistant-turn-1",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "text",
            text: "<command-name>/design-review</command-name>",
          },
        ],
        usage: BASE_USAGE,
      },
    });

    const session = await parseClaudeTranscript([USER_LINE, assistantCommand], {
      sessionId: "assistant-command",
    });

    expect(session?.slashCommands.map((command) => command.name)).toEqual([
      "/design-review",
    ]);
    // The turn id is what a following definition record joins on; without it the
    // command can never be given its snapshot.
    expect(session?.slashCommands[0]?.userTurnId).toBe("assistant-turn-1");
  });

  it("still records a command marker written into USER text", async () => {
    const userCommand = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:01.000Z",
      uuid: "user-turn-1",
      message: {
        role: "user",
        content: "<command-name>/visual-qa</command-name>",
      },
    });

    const session = await parseClaudeTranscript([USER_LINE, userCommand], {
      sessionId: "user-command",
    });

    expect(session?.slashCommands.map((command) => command.name)).toEqual([
      "/visual-qa",
    ]);
  });

  it("drops a command marker on a record the harness never stamped", async () => {
    // `NormalizedSlashCommand.timestamp` is declared non-null: an invocation is
    // a point on the session timeline, and a row claiming a `string` stamp while
    // holding null is worse than an absent row. The paired stamped record proves
    // the marker itself is well-formed, so the drop is the missing stamp.
    const untimed = JSON.stringify({
      type: "user",
      uuid: "untimed-turn",
      message: {
        role: "user",
        content: "<command-name>/logical-qa</command-name>",
      },
    });
    const stamped = JSON.stringify({
      type: "user",
      timestamp: TIMESTAMPS[0],
      uuid: "stamped-turn",
      message: {
        role: "user",
        content: "<command-name>/design</command-name>",
      },
    });

    const session = await parseClaudeTranscript([USER_LINE, untimed, stamped], {
      sessionId: "untimed-command",
    });

    expect(session?.slashCommands.map((command) => command.name)).toEqual([
      "/design",
    ]);
  });
});

describe("an empty string is not a usage-extras value", () => {
  // One `stringValue` switch changed all three of these fields together. Only
  // `inference_geo` had a corpus sample, so only it went red and only it was
  // noticed; these pin the other two so the next change cannot be silent.
  const usageWith = (extras: Record<string, unknown>) =>
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: "hi" }],
        usage: { ...BASE_USAGE, ...extras },
      },
    });

  it("drops an empty inference_geo, service_tier and speed", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        usageWith({ inference_geo: "", service_tier: "", speed: "" }),
      ],
      { sessionId: "empty-extras" }
    );
    expect(session?.usageExtras.inference_geos).toEqual([]);
    expect(session?.usageExtras.service_tiers).toEqual([]);
    expect(session?.usageExtras.speeds).toEqual([]);
  });

  it("keeps real values for all three", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        usageWith({
          inference_geo: "us-east-1",
          service_tier: "standard",
          speed: "fast",
        }),
      ],
      { sessionId: "real-extras" }
    );
    expect(session?.usageExtras.inference_geos).toEqual(["us-east-1"]);
    expect(session?.usageExtras.service_tiers).toEqual(["standard"]);
    expect(session?.usageExtras.speeds).toEqual(["fast"]);
  });
});

describe("nonsensical numbers never reach a persisted field", () => {
  it("drops a non-finite turn duration instead of recording Infinity", async () => {
    // `JSON.parse` yields Infinity for an overflowing literal, and one such turn
    // makes every downstream duration average Infinity.
    // Written as raw JSON, not via JSON.stringify: the overflowing literal has
    // to survive to `JSON.parse` to become Infinity, which is the input under
    // test. A numeric literal in source would be rejected by the linter and
    // rounded by the language before it ever reached the parser.
    const overflow =
      '{"type":"system","subtype":"turn_duration",' +
      '"timestamp":"2026-07-09T12:00:01.000Z","durationMs":1e999}';
    const finite = JSON.stringify({
      type: "system",
      subtype: "turn_duration",
      timestamp: "2026-07-09T12:00:02.000Z",
      durationMs: 1234,
    });

    const session = await parseClaudeTranscript([USER_LINE, overflow, finite], {
      sessionId: "duration-clamp",
    });

    expect(session?.turnDurations.map((turn) => turn.durationMs)).toEqual([
      1234,
    ]);
  });

  it("keeps a compaction marker stamped with a numeric epoch on the timeline", async () => {
    // `isoTs` exists to tolerate the epoch-number shape; reading the field with
    // `stringValue` instead dropped the marker's timestamp to null.
    const compaction = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      uuid: "compaction-1",
      timestamp: 1_767_225_600_000,
      message: { role: "user", content: "summary" },
    });

    const session = await parseClaudeTranscript([USER_LINE, compaction], {
      sessionId: "compaction-epoch",
    });

    // `NormalizedSession.compactions` is declared `unknown[]`, so the shape has
    // to be narrowed here to assert on it.
    const compactions = (session?.compactions ?? []) as Array<{
      uuid: string | null;
      timestamp: string | null;
    }>;
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.timestamp).toBe(
      new Date(1_767_225_600_000).toISOString()
    );
  });
});

describe("the schema-drift report", () => {
  it("names an undecoded record type and its count, once per parse", async () => {
    // The report short-circuits without a logger, so a production surface that
    // omits one gets nothing — which is why the desktop collector passes one and
    // this test drives the same seam.
    const lines: string[] = [USER_LINE];
    for (let i = 0; i < 2; i++) {
      lines.push(
        JSON.stringify({
          type: "brand-new-record-kind",
          timestamp: `2026-07-09T12:00:0${i + 1}.000Z`,
        })
      );
    }
    const messages: string[] = [];
    const accumulator = createSessionAccumulator({ collectDiagnostics: true });
    await scanTranscriptLines(lines, accumulator);
    reportUnknownRecords(accumulator, (message) => messages.push(message));

    const typeReport = messages.find((message) =>
      message.includes("brand-new-record-kind")
    );
    expect(typeReport).toBeDefined();
    expect(typeReport).toContain("2");
  });

  it("says nothing when every record type is decoded", async () => {
    const messages: string[] = [];
    const accumulator = createSessionAccumulator({ collectDiagnostics: true });
    await scanTranscriptLines([USER_LINE], accumulator);
    reportUnknownRecords(accumulator, (message) => messages.push(message));

    expect(messages.filter((m) => m.includes("record type"))).toEqual([]);
  });

  it("orders record types by count, then by name, and tallies each exactly", async () => {
    // Pins the tally arithmetic and the ordering. A counter that decremented, or
    // a comparator that ignored the count, both produce a plausible-looking line
    // that a substring check would accept.
    const lines = [USER_LINE];
    for (let i = 0; i < 3; i++) {
      lines.push(
        JSON.stringify({ type: "zeta-kind", timestamp: TIMESTAMPS[i] })
      );
    }
    lines.push(
      JSON.stringify({ type: "alpha-kind", timestamp: TIMESTAMPS[3] })
    );
    lines.push(JSON.stringify({ type: "beta-kind", timestamp: TIMESTAMPS[4] }));

    const messages: string[] = [];
    const accumulator = createSessionAccumulator({ collectDiagnostics: true });
    await scanTranscriptLines(lines, accumulator);
    reportUnknownRecords(accumulator, (message) => messages.push(message));

    // Highest count first; ties broken by name, so the line is stable across runs.
    expect(messages).toContain(
      "Unknown record types: zeta-kind (3), alpha-kind (1), beta-kind (1)"
    );
  });

  it("reports an undecoded ATTRIBUTE on a KNOWN record type", async () => {
    // The half that actually detects harness drift (ISS-6048): the record type
    // is decoded, but it arrived carrying fields this parser does not read.
    const withNewFields = JSON.stringify({
      type: "ai-title",
      timestamp: "2026-07-09T12:00:01.000Z",
      aiTitle: "known",
      brandNewField: "surprise",
      anotherNewField: 42,
    });

    const messages: string[] = [];
    const accumulator = createSessionAccumulator({ collectDiagnostics: true });
    await scanTranscriptLines([USER_LINE, withNewFields], accumulator);
    reportUnknownRecords(accumulator, (message) => messages.push(message));

    // Attributes sorted and comma-joined, so the same transcript always reports
    // the same line.
    expect(messages).toContain(
      "Unknown attributes for record type ai-title: anotherNewField, brandNewField"
    );
  });

  it("reports a record type's new attribute once, however many records carry it", async () => {
    // The set is per TYPE, not per record — a transcript can carry thousands of
    // one kind, and the answer is the same for all of them.
    const lines = [USER_LINE];
    for (let i = 0; i < 4; i++) {
      lines.push(
        JSON.stringify({
          type: "ai-title",
          timestamp: TIMESTAMPS[i],
          aiTitle: `t${i}`,
          repeatedNewField: i,
        })
      );
    }

    const messages: string[] = [];
    const accumulator = createSessionAccumulator({ collectDiagnostics: true });
    await scanTranscriptLines(lines, accumulator);
    reportUnknownRecords(accumulator, (message) => messages.push(message));

    const attributeLines = messages.filter((message) =>
      message.startsWith("Unknown attributes")
    );
    expect(attributeLines).toEqual([
      "Unknown attributes for record type ai-title: repeatedNewField",
    ]);
  });

  it("says nothing about attributes when every field is known", async () => {
    const messages: string[] = [];
    const accumulator = createSessionAccumulator({ collectDiagnostics: true });
    await scanTranscriptLines(
      [
        USER_LINE,
        JSON.stringify({
          type: "ai-title",
          timestamp: "2026-07-09T12:00:01.000Z",
          aiTitle: "known",
        }),
      ],
      accumulator
    );
    reportUnknownRecords(accumulator, (message) => messages.push(message));

    expect(
      messages.filter((message) => message.startsWith("Unknown attributes"))
    ).toEqual([]);
  });
});

describe("an inline sidechain subagent keeps its provenance metadata", () => {
  it("records the spawning thread and the provider's own agent id", async () => {
    // Persisted into `agents.metadata`. The golden corpus does not discriminate
    // on this field — it passed with and without — which is exactly how a
    // refactor dropped it unnoticed. The derived `id` normalizes both facts
    // away, so these are the only place they survive.
    const sidechain = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      uuid: "sidechain-1",
      parentUuid: "parent-thread-1",
      agentId: "ad00546980b4b4701",
      isSidechain: true,
      message: {
        role: "assistant",
        model: "claude-opus-4",
        // A sidechain row is only created from a `tool_use` block — a
        // text-only sidechain record makes no subagent, in this parser and in
        // the one it replaced.
        content: [
          {
            type: "tool_use",
            id: "toolu_child_1",
            name: "Read",
            input: { file_path: "one.ts" },
          },
        ],
        usage: BASE_USAGE,
      },
    });

    const session = await parseClaudeTranscript([USER_LINE, sidechain], {
      sessionId: "sidechain-metadata",
    });

    expect(session?.subagents?.[0]?.metadata).toEqual({
      parentUuid: "parent-thread-1",
      providerAgentId: "ad00546980b4b4701",
    });
  });

  it("keeps both provenance and delegation keys when the agent is also spawned by a call", async () => {
    // The one interaction the fixture above does not reach, raised by the golden
    // reviewer. `applyDelegationToSubagent` MERGES rather than replaces, and its
    // guard keys on `spawnedByToolUseId`, which the provenance keys do not
    // satisfy — so a sidechain agent later matched to its spawning call carries
    // all four. Both pairs are true facts about the same agent, so four keys is
    // the intended outcome; it is asserted here because nothing else reaches it.
    const spawn = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      uuid: "spawn-1",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_agent_1",
            name: "Agent",
            input: { subagent_type: "code-reviewer", prompt: "Review it" },
          },
        ],
        usage: BASE_USAGE,
      },
    });
    const sidechain = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:02.000Z",
      uuid: "sidechain-2",
      parentUuid: "parent-thread-2",
      agentId: "child-abc123",
      isSidechain: true,
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_child_2",
            name: "Read",
            input: { file_path: "two.ts" },
          },
        ],
        usage: BASE_USAGE,
      },
    });
    const result = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:03.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_agent_1",
            content: [{ type: "text", text: "done" }],
          },
        ],
      },
      toolUseResult: { status: "completed", agentId: "child-abc123" },
    });

    const session = await parseClaudeTranscript(
      [USER_LINE, spawn, sidechain, result],
      { sessionId: "sidechain-metadata-merge" }
    );

    const agent = session?.subagents?.find(
      (candidate) => candidate.metadata?.providerAgentId === "child-abc123"
    );
    expect(agent?.metadata).toMatchObject({
      parentUuid: "parent-thread-2",
      providerAgentId: "child-abc123",
      spawnedByToolUseId: "toolu_agent_1",
    });
  });
});
