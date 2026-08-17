import type {
  SessionTimelineEvent,
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  agent,
  event,
} from "./agent-session-detail-projection.test-helpers.ts";
import {
  deriveAgentSessionFallbackState,
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "./agent-session-detail-projection.ts";

describe("projectAgentSessionTurnItems", () => {
  const baseInput = {
    sessionId: "sess-1",
    harness: "claude-code",
    primaryModel: "claude-opus",
    humanActor: { name: "Ada", color: "var(--human)" },
    events: [] as SyncedAgentSessionEvent[],
    tokenUsageByModel: [] as SyncedAgentSessionTokenUsage[],
  };

  it("coalesces consecutive tool-like events into a single tools turn", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
      { t: "t1", tMs: 1000, kind: "tool", title: "Bash", detail: "ls", tl: 1 },
      {
        t: "t2",
        tMs: 2000,
        kind: "tool",
        title: "Read",
        detail: "file",
        tl: 2,
      },
      {
        t: "t3",
        tMs: 3000,
        kind: "edit",
        title: "Edit",
        detail: "patch",
        err: true,
        tl: 3,
      },
      {
        t: "t4",
        tMs: 4000,
        kind: "say",
        title: "opus",
        detail: "Answer",
        tl: 4,
      },
      {
        t: "t5",
        tMs: 5000,
        kind: "event",
        title: "note",
        detail: "thing",
        git: true,
        tl: 5,
      },
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    expect(items.map((item) => item.type)).toEqual([
      "prompt",
      "tools",
      "say",
      "event",
    ]);

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    expect(prompt.text).toBe("Question");
    expect(prompt.actor.human).toBe("Ada");

    const tools = items[1]!;
    if (tools.type !== "tools") {
      throw new Error("expected tools turn");
    }
    expect(tools.items).toHaveLength(3);
    expect(tools.cats).toEqual({ bash: 1, read: 1, tool: 1 });
    expect(tools.failN).toBe(1);
    expect(tools.hasFail).toBe(true);
    expect(tools.defaultOpen).toBe(true);
    expect(tools.summary).toBe("Ran 3 tools · 1 bash · 1 read · 1 tool");
    expect(tools.tMs).toBe(1000);
    expect(tools.endMs).toBe(3000);

    const event = items[3]!;
    if (event.type !== "event") {
      throw new Error("expected event turn");
    }
    expect(event.dot).toBe("g");
    expect(event.text).toBe("thing");
  });

  it("carries per-call command/output/duration/status onto each ToolItem (FEA-3547)", () => {
    // Two tool events with real transcript detail (tool_input/tool_response),
    // projected end-to-end from raw events → timeline → tools turn.
    const events: SyncedAgentSessionEvent[] = [
      event({
        externalEventId: "e-bash",
        eventType: "PostToolUse",
        toolName: "Bash",
        createdAt: "2026-06-17T00:00:01.000Z",
        data: {
          tool_input: { command: "ls -la" },
          tool_response: { output: "total 8\ndrwxr-xr-x", exitCode: 0 },
          startedAt: "2026-06-17T00:00:01.000Z",
          endedAt: "2026-06-17T00:00:03.500Z",
        },
      }),
      event({
        externalEventId: "e-read",
        eventType: "PostToolUse",
        toolName: "Read",
        createdAt: "2026-06-17T00:00:04.000Z",
        // No data: a transcript-less call must degrade to a bare row.
      }),
    ];

    const timeline = projectAgentSessionTimelineEvents(events, {});
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    const tools = items.find((item) => item.type === "tools");
    if (tools?.type !== "tools") {
      throw new Error("expected a tools turn");
    }
    expect(tools.items).toHaveLength(2);

    const [bash, read] = tools.items;
    expect(bash?.label).toBe("Bash");
    expect(bash?.input).toContain("ls -la");
    expect(bash?.output).toContain("total 8");
    expect(bash?.status).toBe("exit 0");
    expect(bash?.durationMs).toBe(2500);
    expect(bash?.id).toBeTruthy();

    // The detail-less call carries no expansion fields, so the UI renders its
    // empty state rather than a dead chevron.
    expect(read?.input).toBeUndefined();
    expect(read?.output).toBeUndefined();
    expect(read?.durationMs).toBeUndefined();
  });

  describe("truthful tool-call detail state + identity (FEA-3696)", () => {
    // One helper that runs a single tool event end-to-end and returns its
    // projected ToolItem, so each state case reads as a tiny table row.
    function toolItemFor(
      overrides: Partial<SyncedAgentSessionEvent> &
        Pick<SyncedAgentSessionEvent, "externalEventId" | "toolName">
    ) {
      const events: SyncedAgentSessionEvent[] = [
        event({
          eventType: "PostToolUse",
          createdAt: "2026-06-17T00:00:01.000Z",
          ...overrides,
        }),
      ];
      const timeline = projectAgentSessionTimelineEvents(events, {});
      const items = projectAgentSessionTurnItems({
        ...baseInput,
        timeline,
        agents: [],
      });
      const tools = items.find((item) => item.type === "tools");
      if (tools?.type !== "tools") {
        throw new Error("expected a tools turn");
      }
      return tools.items[0];
    }

    it("stamps `available` for a whole function tool call with input+output", () => {
      const tool = toolItemFor({
        externalEventId: "fn-1",
        toolName: "Bash",
        data: {
          tool_input: { command: "ls -la" },
          tool_response: { output: "ok", exitCode: 0 },
        },
      });
      expect(tool?.detailState).toBe("available");
      // Identity is preserved from the source event id across surfaces.
      expect(tool?.callId).toBe("fn-1");
    });

    it("stamps `truncated` for a custom tool call clipped to the caps", () => {
      const tool = toolItemFor({
        externalEventId: "custom-1",
        toolName: "MyCustomTool",
        data: {
          tool_input: { payload: "x".repeat(5000) },
          tool_response: { output: "y".repeat(20_000) },
        },
      });
      expect(tool?.detailState).toBe("truncated");
      expect(tool?.inputTruncated || tool?.outputTruncated).toBe(true);
      expect(tool?.callId).toBe("custom-1");
    });

    it("stamps `unavailable` for an MCP call with no `data` (cloud DB path)", () => {
      // The cloud DB-events path strips `data` (FEA-2718): detail lives only in
      // the archived transcript, so the row must say so — not "no detail".
      const tool = toolItemFor({
        externalEventId: "mcp-1",
        toolName: "mcp__figma__get_file",
      });
      expect(tool?.detailState).toBe("unavailable");
      // Identity still minted so the row can be keyed + lazily re-fetched.
      expect(tool?.callId).toBe("mcp-1");
      expect(tool?.input).toBeUndefined();
      expect(tool?.output).toBeUndefined();
    });

    it("stamps `redacted` when the producer marked the detail removed", () => {
      const tool = toolItemFor({
        externalEventId: "redacted-1",
        toolName: "Bash",
        data: { redacted: true },
      });
      expect(tool?.detailState).toBe("redacted");
      expect(tool?.callId).toBe("redacted-1");
      expect(tool?.input).toBeUndefined();
      expect(tool?.output).toBeUndefined();
    });

    it("stamps `available` for a status/duration-only call via the hasMeta branch (not malformed)", () => {
      // `data` present with a derivable exit status + duration but NO parseable
      // tool_input/tool_response text: exit status and duration live at the top
      // level so `jsonToDisplayText(data.tool_response)` collapses to null and
      // neither `input` nor `output` is set. This genuinely exercises the
      // `hasMeta`-only branch of `deriveToolDetailState` — the row still expands
      // to show its meta, so it is `available`, NOT `malformed`.
      const tool = toolItemFor({
        externalEventId: "status-1",
        toolName: "Bash",
        data: { exit_code: 0, duration_ms: 1200 },
      });
      expect(tool?.detailState).toBe("available");
      // The only detail present is meta — input/output are absent, proving the
      // `available` verdict came from `hasMeta`, not a serialized response blob.
      expect(tool?.input).toBeUndefined();
      expect(tool?.output).toBeUndefined();
      expect(tool?.status).toBe("exit 0");
      expect(tool?.durationMs).toBe(1200);
      expect(tool?.callId).toBe("status-1");
    });

    it("stamps `malformed` when `data` is present but unparseable to text", () => {
      // `data` exists (so not `unavailable`) but neither tool_input nor a
      // command nor tool_response resolves to displayable text (empty/whitespace
      // values collapse to null in jsonToDisplayText).
      const tool = toolItemFor({
        externalEventId: "bad-1",
        toolName: "Bash",
        data: { tool_input: "   ", tool_response: "" },
      });
      expect(tool?.detailState).toBe("malformed");
      expect(tool?.callId).toBe("bad-1");
      expect(tool?.input).toBeUndefined();
      expect(tool?.output).toBeUndefined();
    });

    it("does NOT stamp `unavailable` for a tool-like row with no `toolName` (mcp/edit substring classification)", () => {
      // An event with no `toolName` but an eventType that substring-matches
      // `mcp`/`edit` is classified as a tool-LIKE timeline row (kind `mcp`/`edit`)
      // but NEVER runs through `toolCallDetailFields` — it carries no source
      // `externalEventId` on the row (only a synthetic fallback `callId`) and no
      // hydrate-able detail behind it. `unavailable` would LIE about that row (it
      // promises "detail exists elsewhere, fetch it lazily"), so a detail-less
      // such row must be `malformed` instead — honest "no readable detail", no
      // false promise of re-fetchability.
      const timeline: SessionTimelineEvent[] = [
        {
          t: "2026-06-17T00:00:01.000Z",
          tMs: Date.parse("2026-06-17T00:00:01.000Z"),
          kind: "mcp",
          title: "mcp call",
          detail: "mcp call",
          tl: 0,
        },
      ];
      const items = projectAgentSessionTurnItems({
        ...baseInput,
        timeline,
        agents: [],
      });
      const tools = items.find((item) => item.type === "tools");
      if (tools?.type !== "tools") {
        throw new Error("expected a tools turn");
      }
      const row = tools.items[0];
      expect(row?.detailState).toBe("malformed");
      expect(row?.detailState).not.toBe("unavailable");
      expect(row?.input).toBeUndefined();
      expect(row?.output).toBeUndefined();
      // The `callId` is a synthetic fallback (tl-runIndex), NOT a source event id,
      // confirming there is no keyed transcript detail to promise.
      expect(row?.callId).toBe("0-0");
    });
  });

  it("drops Stop/SubagentStop turn-boundary markers but keeps session lifecycle rows", () => {
    const timeline: SessionTimelineEvent[] = [
      {
        t: "t0",
        tMs: 0,
        kind: "event",
        title: "SessionStart",
        detail: "SessionStart",
        tl: 0,
      },
      { t: "t1", tMs: 1000, kind: "tool", title: "Read", detail: "a", tl: 1 },
      {
        t: "t2",
        tMs: 2000,
        kind: "event",
        title: "Stop",
        isBoundary: true,
        tl: 2,
      },
      {
        t: "t3",
        tMs: 3000,
        kind: "event",
        title: "SubagentStop",
        isBoundary: true,
        tl: 3,
      },
      {
        t: "t4",
        tMs: 4000,
        kind: "event",
        title: "SessionEnd",
        detail: "SessionEnd",
        tl: 4,
      },
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    expect(items.map((item) => item.type)).toEqual(["event", "tools", "event"]);
    const texts = items
      .filter((item) => item.type === "event")
      .map((item) => (item.type === "event" ? item.text : ""));
    expect(texts).toEqual(["SessionStart", "SessionEnd"]);
  });

  it("coalesces tool runs separated only by a Stop marker into one tools turn", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "tool", title: "Read", detail: "a", tl: 0 },
      {
        t: "t1",
        tMs: 1000,
        kind: "event",
        title: "Stop",
        isBoundary: true,
        tl: 1,
      },
      { t: "t2", tMs: 2000, kind: "tool", title: "Bash", detail: "ls", tl: 2 },
      {
        t: "t3",
        tMs: 3000,
        kind: "event",
        title: "Stop",
        isBoundary: true,
        tl: 3,
      },
      { t: "t4", tMs: 4000, kind: "tool", title: "Grep", detail: "x", tl: 4 },
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    expect(items.map((item) => item.type)).toEqual(["tools"]);
    const tools = items[0]!;
    if (tools.type !== "tools") {
      throw new Error("expected tools turn");
    }
    expect(tools.items).toHaveLength(3);
    expect(tools.summary).toBe("Ran 3 tools · 1 bash · 1 read · 1 tool");
    expect(tools.tMs).toBe(0);
    expect(tools.endMs).toBe(4000);
  });

  it("carries model and reasoning flags onto say turns without leaking labels into text", () => {
    const timeline: SessionTimelineEvent[] = [
      {
        t: "t0",
        tMs: 0,
        kind: "say",
        title: "Reasoning",
        isThinking: true,
        tl: 0,
      },
      {
        t: "t1",
        tMs: 1000,
        kind: "say",
        title: "claude-opus",
        model: "claude-opus",
        detail: "All done",
        tl: 1,
      },
      {
        t: "t2",
        tMs: 2000,
        kind: "say",
        title: "claude-opus",
        model: "claude-opus",
        tl: 2,
      },
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    const says = items.filter((item) => item.type === "say");
    expect(
      says.map((item) => [item.text, item.isThinking, item.model])
    ).toEqual([
      // Redacted reasoning: empty text, flagged as thinking.
      ["", true, undefined],
      // Response text keeps its body and carries the model caption.
      ["All done", undefined, "claude-opus"],
      // Text-less model marker no longer falls back to the model label.
      ["", undefined, "claude-opus"],
    ]);
  });

  it("projects subagents with duration, token, and cost formatting after timeline rows", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "say", title: "opus", detail: "hi", tl: 0 },
    ];
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "completed",
        task: "Find usages",
        currentTool: "Grep",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:01:30.000Z",
      }),
      agent({
        externalAgentId: "main",
        name: "main",
        type: "primary",
        status: "running",
      }),
    ];
    const tokenUsageByModel: SyncedAgentSessionTokenUsage[] = [
      {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 300,
        estimatedCostUsd: 1.5,
      },
    ];
    const events: SyncedAgentSessionEvent[] = [
      event({
        externalEventId: "ev-1",
        agentExternalId: "sub-1",
        eventType: "tool_use",
        toolName: "Grep",
        createdAt: "2026-06-17T00:00:10.000Z",
      }),
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents,
      events,
      tokenUsageByModel,
    });

    const subagents = items.filter((item) => item.type === "subagent");
    expect(subagents).toHaveLength(1);
    const sub = subagents[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.sub).toBe("Explorer");
    expect(sub.subagentType).toBe("Explore");
    expect(sub.duration).toBe("1m 30s");
    expect(sub.tokens).toBeNull();
    expect(sub.cost).toBeNull();
    expect(sub.body.map((line) => [line.kind, line.text])).toEqual([
      ["task", "Find usages"],
      ["tool", "Grep"],
      ["tool", "Grep"],
      ["status", "completed"],
    ]);
    // Subagents sort after the timeline-derived turns.
    expect(items.at(-1)).toBe(sub);
  });

  it("anchors an un-ended subagent's duration to its last event, not mutable updatedAt (FEA-3451)", () => {
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "running",
        startedAt: "2026-06-17T00:00:00.000Z",
        // No endedAt: updatedAt was bumped long after real activity ceased.
        updatedAt: "2026-06-17T02:00:00.000Z",
      }),
    ];
    const events: SyncedAgentSessionEvent[] = [
      event({
        externalEventId: "ev-1",
        agentExternalId: "sub-1",
        eventType: "tool_use",
        toolName: "Grep",
        createdAt: "2026-06-17T00:00:20.000Z",
      }),
      event({
        externalEventId: "ev-2",
        agentExternalId: "sub-1",
        eventType: "tool_use",
        toolName: "Read",
        createdAt: "2026-06-17T00:00:45.000Z",
      }),
      // Another subagent's event must not extend this one's window.
      event({
        externalEventId: "ev-other",
        agentExternalId: "sub-2",
        eventType: "tool_use",
        createdAt: "2026-06-17T01:00:00.000Z",
      }),
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
      events,
    });

    const sub = items.find((item) => item.type === "subagent");
    if (sub?.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    // 45s of activity, not the ~2h implied by updatedAt.
    expect(sub.duration).toBe("45s");
  });

  it("falls back to updatedAt for an un-ended subagent with no activity events (FEA-3451)", () => {
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "running",
        startedAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:30.000Z",
      }),
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
    });

    const sub = items.find((item) => item.type === "subagent");
    if (sub?.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.duration).toBe("30s");
  });

  it("emits null duration, tokens, and cost when data is missing or inconsistent", () => {
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "NoTiming",
        type: "subagent",
        subagentType: "Explore",
        status: "running",
        // endedAt precedes startedAt → duration is rejected.
        startedAt: "2026-06-17T00:01:00.000Z",
        endedAt: "2026-06-17T00:00:00.000Z",
      }),
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.duration).toBeNull();
    expect(sub.tokens).toBeNull();
    expect(sub.cost).toBeNull();
  });
});

/*
 * ISS-6588 deleted the cases covering the `completed`/`abandoned` branches and
 * the FEA-3551 PR rescue. Those contracts were retired, not relocated — the
 * spellings are unreachable and the branches that read them are gone, so there
 * is nothing left for those assertions to protect.
 *
 * The behaviour that survived them is pinned below: `error`/`failed` still
 * carry the terminal FAILURE outcome (FEA-4287), and the fallthrough a retired
 * spelling now reaches is asserted rather than left incidental.
 */
describe("deriveAgentSessionFallbackState", () => {
  // FEA-4287: terminal ERROR/FAILED preserve the Error outcome instead of
  // collapsing to Blocked, so the detail projection matches what the Sessions
  // LIST renders.
  it("returns Error for the terminal error status", () => {
    // ISS-5592 dropped the `failed` alias with the rest of the alias map: the
    // desktop no longer manufactures that spelling, so `error` is what arrives.
    expect(deriveAgentSessionFallbackState({ status: "error" })).toBe("ERROR");
  });

  it("classifies an unrecognized status by its evidence, not by its spelling", () => {
    // The ISS-6588 consequence, pinned so it is a decision rather than a
    // side effect: with no branch of its own, a spelling this build does not
    // model is judged on `endedAt` alone.
    expect(
      deriveAgentSessionFallbackState({
        status: "abandoned",
        endedAt: "2026-06-17T00:00:00.000Z",
      })
    ).toBe("COMPLETED");
    expect(deriveAgentSessionFallbackState({ status: "abandoned" })).toBe(
      "RUNNING"
    );
  });

  it("returns PendingApproval when awaiting input and not ended", () => {
    expect(
      deriveAgentSessionFallbackState({
        status: "active",
        awaitingInputSince: "2026-06-17T00:00:00.000Z",
      })
    ).toBe("PENDING_APPROVAL");
  });

  it("treats an ended-but-uncanonicalized session as Completed", () => {
    expect(
      deriveAgentSessionFallbackState({
        status: "active",
        awaitingInputSince: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:05:00.000Z",
      })
    ).toBe("COMPLETED");
  });

  it("falls back to Running for an active session with no terminal signals", () => {
    expect(deriveAgentSessionFallbackState({ status: "active" })).toBe(
      "RUNNING"
    );
  });
});

// ---------------------------------------------------------------------------
// Additional projection tests covering previously uncovered branch paths.
// ---------------------------------------------------------------------------
