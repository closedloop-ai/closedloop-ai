/**
 * @file parse-claude-fork-replay.test.ts
 * @description ISS-8659 — a forked session must count only its OWN work.
 *
 * Claude Code's fork replays the parent session's records verbatim into the
 * child's transcript — same `uuid`, same `message.id`, same usage numbers — each
 * stamped `forkedFrom`. Nothing dedupes across sessions: `seenEntryUuids` is
 * scoped to one file and the cloud's token uniques are per `agentSessionId`, so
 * every replayed record was counted once in the parent and again in the fork.
 *
 * EVERY case here parses the same transcript TWICE, differing only in whether
 * the inherited records carry the stamp. That is the control arm: a figure that
 * moves between the two runs moved because of the gate and nothing else, and the
 * unstamped run standing still is the "a parent's own totals are unchanged" half
 * of the contract, which a one-sided assertion cannot distinguish from the
 * parser simply under-counting everything.
 */
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude";

const PARENT_SESSION_ID = "0e0036cc-8ac4-4dc7-a9e4-9920b4e657ae";
const FORK_STAMP = {
  sessionId: PARENT_SESSION_ID,
  messageUuid: "1cd3ab85-25f3-416f-b312-00dcaaeacd7c",
};

const INHERITED_MODEL = "claude-opus-5";

/** The stamp a fork puts on a replayed record, or nothing for its own work. */
function stamp(replayed: boolean): Record<string, unknown> {
  return replayed ? { forkedFrom: FORK_STAMP } : {};
}

/**
 * The five inherited records: a human turn, an assistant turn carrying usage, a
 * thinking block and a tool call, that call's failing result, a hook firing, and
 * a measured turn duration. One of each lane ISS-8659 names.
 */
function inheritedLines(replayed: boolean): string[] {
  return [
    JSON.stringify({
      type: "user",
      uuid: "inherited-user",
      timestamp: "2026-08-31T19:59:53.393Z",
      cwd: "/repo",
      ...stamp(replayed),
      message: { role: "user", content: "the parent's prompt" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "inherited-assistant",
      timestamp: "2026-08-31T20:00:10.000Z",
      ...stamp(replayed),
      message: {
        role: "assistant",
        id: "msg_parent",
        model: INHERITED_MODEL,
        content: [
          { type: "thinking", thinking: "parent reasoning" },
          {
            type: "tool_use",
            id: "toolu_parent",
            name: "Bash",
            input: { command: "echo parent" },
          },
        ],
        usage: {
          input_tokens: 46,
          output_tokens: 13_191,
          cache_read_input_tokens: 2_559_480,
          cache_creation_input_tokens: 123_024,
          // Deliberately DIFFERENT from the fork's own turn below, so the
          // usage-extras case can tell inheritance from coincidence.
          service_tier: "priority",
          speed: "fast",
          inference_geo: "eu-west",
          server_tool_use: { web_search_requests: 7 },
        },
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "inherited-result",
      timestamp: "2026-08-31T20:00:12.000Z",
      ...stamp(replayed),
      toolUseResult: { is_error: true, content: "the parent's failure" },
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_parent",
            content: "the parent's failure",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "attachment",
      uuid: "inherited-hook",
      timestamp: "2026-08-31T20:00:13.000Z",
      ...stamp(replayed),
      attachment: {
        type: "hook_success",
        hookName: "ParentHook",
        hookEvent: "PostToolUse",
        command: "echo hook",
      },
    }),
    JSON.stringify({
      type: "system",
      uuid: "inherited-duration",
      timestamp: "2026-08-31T20:00:14.000Z",
      subtype: "turn_duration",
      durationMs: 4000,
      ...stamp(replayed),
    }),
  ];
}

/** The fork's own work: one human turn and one billable assistant turn. */
const OWN_LINES = [
  JSON.stringify({
    type: "user",
    uuid: "own-user",
    timestamp: "2026-08-31T20:33:14.913Z",
    cwd: "/repo",
    message: { role: "user", content: "the fork's own prompt" },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "own-assistant",
    timestamp: "2026-08-31T20:34:47.267Z",
    message: {
      role: "assistant",
      id: "msg_own",
      model: INHERITED_MODEL,
      content: [{ type: "thinking", thinking: "the fork's own reasoning" }],
      usage: {
        input_tokens: 4,
        output_tokens: 5112,
        cache_read_input_tokens: 181_383,
        cache_creation_input_tokens: 135_353,
        service_tier: "standard",
        speed: "standard",
        server_tool_use: { web_search_requests: 0 },
      },
    },
  }),
];

/**
 * An inherited record that ALSO carries `isSidechain` — a delegation the parent
 * made, replayed into the child. No dossier in the corpus has one (the ISS-8659
 * measurement found `isSidechain` = 0 across every replayed record on five real
 * forks), so this fixture is the only thing holding that lane.
 */
function inheritedSidechainLine(replayed: boolean): string {
  return JSON.stringify({
    type: "assistant",
    uuid: "inherited-sidechain",
    timestamp: "2026-08-31T20:00:20.000Z",
    isSidechain: true,
    agentId: "a1b2c3d4e5f60718",
    attributionAgent: "the parent's delegate",
    ...stamp(replayed),
    message: {
      role: "assistant",
      id: "msg_parent_sidechain",
      model: INHERITED_MODEL,
      content: [
        {
          type: "tool_use",
          id: "toolu_parent_sidechain",
          name: "Read",
          input: { file_path: "/repo/a.ts" },
        },
      ],
    },
  });
}

function parseWith(replayed: boolean) {
  return parseClaudeTranscript([...inheritedLines(replayed), ...OWN_LINES], {
    sessionId: "aff9f567-f770-4b4d-ad6f-73f9a04be5f5",
  });
}

describe("fork replay — tallies count the fork's own work only", () => {
  it("excludes replayed records from every tally, and counts them when unstamped", async () => {
    const fork = await parseWith(true);
    const control = await parseWith(false);

    expect(fork?.userMessages).toBe(1);
    expect(control?.userMessages).toBe(2);

    expect(fork?.assistantMessages).toBe(1);
    expect(control?.assistantMessages).toBe(2);

    expect(fork?.thinkingBlockCount).toBe(1);
    expect(control?.thinkingBlockCount).toBe(2);

    expect(fork?.toolUses).toHaveLength(0);
    expect(control?.toolUses).toHaveLength(1);

    expect(fork?.toolResultErrors).toHaveLength(0);
    expect(control?.toolResultErrors).toHaveLength(1);

    expect(fork?.hooks).toHaveLength(0);
    expect(control?.hooks).toHaveLength(1);

    expect(fork?.turnDurations).toHaveLength(0);
    expect(control?.turnDurations).toHaveLength(1);
  });

  it("bills the fork for its own round-trip only", async () => {
    const fork = await parseWith(true);
    const control = await parseWith(false);

    expect(fork?.tokensByModel[INHERITED_MODEL]).toEqual({
      input: 4,
      output: 5112,
      cacheRead: 181_383,
      cacheWrite: 135_353,
    });
    // The same records, unstamped, still bill both turns — so the exclusion above
    // is the stamp doing its job, not the parser losing usage.
    expect(control?.tokensByModel[INHERITED_MODEL]?.output).toBe(18_303);
    expect(control?.tokensByModel[INHERITED_MODEL]?.cacheRead).toBe(2_740_863);
  });

  it("reports the fork's own span, not the parent's", async () => {
    const fork = await parseWith(true);
    const control = await parseWith(false);

    expect(fork?.startedAt).toBe("2026-08-31T20:33:14.913Z");
    expect(control?.startedAt).toBe("2026-08-31T19:59:53.393Z");
    // The end is the fork's own last record either way; only the start moved.
    expect(fork?.endedAt).toBe("2026-08-31T20:34:47.267Z");
    expect(control?.endedAt).toBe("2026-08-31T20:34:47.267Z");
  });

  it("KEEPS the inherited conversation, which is why records are not skipped", async () => {
    const fork = await parseWith(true);

    // The replayed human turn is still in the trace even though it is not
    // counted: dropping it would open session detail mid-conversation, which is
    // the capability option (a) would have traded away.
    const humanTexts = (fork?.messages ?? [])
      .filter((message) => message.role === "human")
      .map((message) => message.text);
    expect(humanTexts).toEqual([
      "the parent's prompt",
      "the fork's own prompt",
    ]);
  });

  it("stamps the parent's session id, and omits the field on a root session", async () => {
    const fork = await parseWith(true);
    const control = await parseWith(false);

    expect(fork?.claudeForkedFromSessionId).toBe(PARENT_SESSION_ID);
    // Absent rather than null, so a root session round-trips byte-identically.
    expect(control).not.toHaveProperty("claudeForkedFromSessionId");
  });

  it("marks the kept messages as replay, so a counter can tell them apart", async () => {
    const fork = await parseWith(true);
    const control = await parseWith(false);

    // Keeping the message and excluding it from `userMessages` leaves
    // `messages` the RENDERED conversation rather than a tally — so anything
    // that counts the array (session_analytics.human_turns, the turn buckets,
    // the cloud activity heatmap) needs the fact carried on the message.
    const humans = (fork?.messages ?? []).filter((m) => m.role === "human");
    expect(humans.map((m) => [m.text, m.isForkReplayed === true])).toEqual([
      ["the parent's prompt", true],
      ["the fork's own prompt", false],
    ]);

    // Omitted entirely when nothing is replayed, so an unforked session's
    // payload is byte-identical to what it was before this field existed.
    for (const message of control?.messages ?? []) {
      expect(message).not.toHaveProperty("isForkReplayed");
    }
  });
});

describe("fork replay — how the parent's turn ran is the parent's fact", () => {
  it("does not inherit the parent's service tier, speed, geo or web searches", async () => {
    const fork = await parseWith(true);
    const control = await parseWith(false);

    // The sets UNION and web_search_requests takes a MAX, so neither can
    // double-count WITHIN a session — which is why the issue text lists these as
    // unaffected. That is true and not the same as harmless. Without the gate the
    // fork reports a tier, a speed and a geo it never ran at; and because
    // `webSearchCostSql` PRICES the persisted web_search_requests, it is also
    // billed for seven searches its parent had already been billed for.
    expect(fork?.usageExtras?.service_tiers).toEqual(["standard"]);
    expect(fork?.usageExtras?.speeds).toEqual(["standard"]);
    expect(fork?.usageExtras?.inference_geos).toEqual([]);
    expect(fork?.usageExtras?.web_search_requests).toBe(0);

    // Unstamped, the very same records ARE this session's own work.
    expect(control?.usageExtras?.service_tiers).toEqual(
      expect.arrayContaining(["priority", "standard"])
    );
    expect(control?.usageExtras?.speeds).toEqual(
      expect.arrayContaining(["fast", "standard"])
    );
    expect(control?.usageExtras?.inference_geos).toEqual(["eu-west"]);
    expect(control?.usageExtras?.web_search_requests).toBe(7);
  });

  it("does not enrol a subagent the parent delegated to", async () => {
    const forkLines = [
      ...inheritedLines(true),
      inheritedSidechainLine(true),
      ...OWN_LINES,
    ];
    const controlLines = [
      ...inheritedLines(false),
      inheritedSidechainLine(false),
      ...OWN_LINES,
    ];
    const fork = await parseClaudeTranscript(forkLines, {
      sessionId: "aff9f567-f770-4b4d-ad6f-73f9a04be5f5",
    });
    const control = await parseClaudeTranscript(controlLines, {
      sessionId: "aff9f567-f770-4b4d-ad6f-73f9a04be5f5",
    });

    // The row would otherwise arrive in the fork's own roster with no work
    // attached to it — the per-call attribution is already skipped for replay.
    expect(fork?.subagents ?? []).toEqual([]);
    expect((control?.subagents ?? []).map((s) => s.name)).toEqual([
      "the parent's delegate",
    ]);
  });
});

describe("fork replay — a fork that has not done anything yet", () => {
  it("still parses when every record it holds is replayed", async () => {
    // `!startedAt` is the parser's "no usable timestamp anywhere, so this is not
    // a session" test, and the desktop shell additionally reports that case as an
    // INGEST FAILURE. A fork observed between the replay being written and the
    // user's first prompt has hundreds of readable timestamps and is neither.
    const bare = await parseClaudeTranscript(inheritedLines(true), {
      sessionId: "aff9f567-f770-4b4d-ad6f-73f9a04be5f5",
    });

    expect(bare).not.toBeNull();
    // Inherited, because it is the only time information the file carries. This
    // cannot re-inflate a working fork: one own record and the fallback is dead.
    expect(bare?.startedAt).toBe("2026-08-31T19:59:53.393Z");
    // Still counts none of the parent's work.
    expect(bare?.userMessages).toBe(0);
    expect(bare?.assistantMessages).toBe(0);
  });
});

describe("fork replay — the marker itself", () => {
  it("ignores a half-formed stamp rather than dropping a real record", async () => {
    // Only `sessionId`, no `messageUuid`. Reading this as a replay would silently
    // drop a record the fork really did author, which looks exactly like correct
    // exclusion and is invisible in the totals.
    const halfStamped = JSON.stringify({
      type: "user",
      uuid: "half-stamped",
      timestamp: "2026-08-31T20:35:00.000Z",
      cwd: "/repo",
      forkedFrom: { sessionId: PARENT_SESSION_ID },
      message: { role: "user", content: "still the fork's own turn" },
    });

    const session = await parseClaudeTranscript([...OWN_LINES, halfStamped], {
      sessionId: "half-stamped-fork",
    });

    expect(session?.userMessages).toBe(2);
    expect(session).not.toHaveProperty("claudeForkedFromSessionId");
  });
});

describe("fork replay — state a replayed record must still carry", () => {
  it("keeps a replayed Read as the diff baseline for the fork's own Write", async () => {
    // The reason replayed records are processed rather than skipped: a `Read`
    // body is the baseline the next `Write` of that path is diffed against. Skip
    // the replayed read and the fork's own Write counts the whole file as
    // additions — inflating diffs in the opposite direction.
    const replayedRead = JSON.stringify({
      type: "assistant",
      uuid: "replayed-read",
      timestamp: "2026-08-31T20:00:20.000Z",
      forkedFrom: FORK_STAMP,
      message: {
        role: "assistant",
        id: "msg_parent_read",
        model: INHERITED_MODEL,
        content: [
          {
            type: "tool_use",
            id: "toolu_read",
            name: "Read",
            input: { file_path: "/repo/src/auth.ts" },
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    const replayedReadResult = JSON.stringify({
      type: "user",
      uuid: "replayed-read-result",
      timestamp: "2026-08-31T20:00:21.000Z",
      forkedFrom: FORK_STAMP,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_read",
            content: "1\tconst a = 1;\n2\tconst b = 2;",
          },
        ],
      },
    });
    const ownWrite = JSON.stringify({
      type: "assistant",
      uuid: "own-write",
      timestamp: "2026-08-31T20:34:50.000Z",
      message: {
        role: "assistant",
        id: "msg_own_write",
        model: INHERITED_MODEL,
        content: [
          {
            type: "tool_use",
            id: "toolu_write",
            name: "Write",
            input: {
              file_path: "/repo/src/auth.ts",
              content: "const a = 1;\nconst b = 2;\nconst c = 3;",
            },
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });

    const session = await parseClaudeTranscript(
      [...OWN_LINES, replayedRead, replayedReadResult, ownWrite],
      { sessionId: "fork-read-write-diff" }
    );

    // 2 baseline lines → 3 written: one added, nothing removed. A lost baseline
    // would report 3 additions instead.
    expect(session?.diffStats?.linesAdded).toBe(1);
    expect(session?.diffStats?.linesRemoved).toBe(0);
    // The replayed Read is excluded from the tally even though it ran.
    expect(session?.toolUses.map((toolUse) => toolUse.name)).toEqual(["Write"]);
  });

  it("keeps a replayed Write as the baseline for the fork's own Write", async () => {
    // The Read case above proves the replayed CALL stays indexed so its result
    // can cache a body. This one proves the other half: a replayed `Write` must
    // still advance `readContentByPath` from the call side, which is what
    // `applyDiffStatsToolUseState` is for. Run the handler not at all and the
    // path looks never-written, so the fork's own Write counts the whole file as
    // additions.
    const writeLine = (replayed: boolean, uuid: string, content: string) =>
      JSON.stringify({
        type: "assistant",
        uuid,
        timestamp: replayed
          ? "2026-08-31T20:00:50.000Z"
          : "2026-08-31T20:34:55.000Z",
        ...stamp(replayed),
        message: {
          role: "assistant",
          id: `msg_${uuid}`,
          model: INHERITED_MODEL,
          content: [
            {
              type: "tool_use",
              id: `toolu_${uuid}`,
              name: "Write",
              input: { file_path: "/repo/src/config.ts", content },
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      });

    const session = await parseClaudeTranscript(
      [
        ...OWN_LINES,
        writeLine(true, "replayed-write", "const a = 1;\nconst b = 2;"),
        writeLine(
          false,
          "own-write",
          "const a = 1;\nconst b = 2;\nconst c = 3;"
        ),
      ],
      { sessionId: "fork-write-write-diff" }
    );

    // The parent wrote 2 lines; the fork added 1. Without the replayed Write's
    // state transition this reads as 3 additions.
    expect(session?.diffStats?.linesAdded).toBe(1);
    expect(session?.diffStats?.linesRemoved).toBe(0);
    // ...and the replayed Write is still excluded from the tally.
    expect(session?.toolUses.map((toolUse) => toolUse.name)).toEqual(["Write"]);
  });

  // NOTE (ISS-8659): there is deliberately no case here for "a replayed tool
  // result does not mint a phantom delegation". Keeping the replayed call in
  // `toolUses` and indexed IS what prevents that, but the effect is not
  // observable in `NormalizedSession` at this layer: `buildSession` applies a
  // delegation only to a subagent already in the map (`if (spawned)`), so an
  // orphan naming a never-seen child produces nothing to assert on. The
  // index-stays-populated contract is covered by the replayed-Read case above,
  // which goes red the moment the call is dropped before the push.
});

describe("fork replay — session.model is the fork's own", () => {
  const OWN_MODEL = "claude-fable-5";

  /** `OWN_LINES`, re-stamped onto a model the parent never ran. */
  function ownLinesOnModel(model: string): string[] {
    return OWN_LINES.map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      const message = record.message as Record<string, unknown> | undefined;
      if (message && typeof message.model === "string") {
        message.model = model;
      }
      return JSON.stringify(record);
    });
  }

  it("reports the model the fork ran on, not the one it inherited", async () => {
    // `model` is first-wins and a fork's FIRST assistant record is replayed, so
    // an ungated assignment always returned the parent's id. It reaches the
    // Sessions list as this session's model, so the row filters and summarises
    // under a model it never used.
    const fork = await parseClaudeTranscript(
      [...inheritedLines(true), ...ownLinesOnModel(OWN_MODEL)],
      { sessionId: "aff9f567-f770-4b4d-ad6f-73f9a04be5f5" }
    );
    expect(fork?.model).toBe(OWN_MODEL);

    // Unstamped, those same records ARE this session's own work, and first-wins
    // legitimately takes the earliest of them.
    const control = await parseClaudeTranscript(
      [...inheritedLines(false), ...ownLinesOnModel(OWN_MODEL)],
      { sessionId: "aff9f567-f770-4b4d-ad6f-73f9a04be5f5" }
    );
    expect(control?.model).toBe(INHERITED_MODEL);
  });

  it("falls back to the inherited model when the fork has answered nothing", async () => {
    // Forked and abandoned, or caught between the replay landing and the first
    // own turn. Reporting null would hide a model the conversation on screen
    // demonstrably ran on; the fallback only ever fires when there is no own id
    // to prefer.
    const fork = await parseClaudeTranscript(inheritedLines(true), {
      sessionId: "aff9f567-f770-4b4d-ad6f-73f9a04be5f5",
    });
    expect(fork?.model).toBe(INHERITED_MODEL);
  });
});
