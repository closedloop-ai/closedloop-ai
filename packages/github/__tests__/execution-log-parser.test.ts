import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import {
  buildExecutionTrace,
  createEmptyExecutionTrace,
  deriveAgentLabel,
  parseConversationJsonl,
  parseExecutionLogs,
  parseSessionIndex,
} from "../execution-log-parser";

// ---------- helpers ----------

function toBuffer(content: string): Buffer {
  return Buffer.from(content, "utf-8");
}

function makeJsonlLines(
  records: { role: string; content: unknown; timestamp: string }[]
): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

function buildConversationZip(sessions: {
  indexEntries?: { sessionId: string; path: string; created: string }[];
  indexPath?: string;
  files: { path: string; content: string }[];
}): Buffer {
  const zip = new AdmZip();
  if (sessions.indexEntries) {
    const indexPath =
      sessions.indexPath ?? ".claude/runs/conversations/sessions-index.json";
    zip.addFile(indexPath, toBuffer(JSON.stringify(sessions.indexEntries)));
  }
  for (const file of sessions.files) {
    zip.addFile(file.path, toBuffer(file.content));
  }
  return zip.toBuffer();
}

/** Wrap an inner zip buffer inside an outer zip as symphony-run.zip */
function buildNestedZip(innerZipBuffer: Buffer): Buffer {
  const outerZip = new AdmZip();
  outerZip.addFile("symphony-run.zip", innerZipBuffer);
  return outerZip.toBuffer();
}

// ---------- parseSessionIndex ----------

describe("parseSessionIndex", () => {
  it("parses valid session index entries", () => {
    const data = [
      {
        sessionId: "abc-123",
        path: "abc-123.jsonl",
        created: "2025-01-01T00:00:00Z",
      },
      {
        sessionId: "def-456",
        path: "def-456.jsonl",
        created: "2025-01-02T00:00:00Z",
      },
    ];
    const result = parseSessionIndex(toBuffer(JSON.stringify(data)));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(data[0]);
  });

  it("filters out entries with missing required fields", () => {
    const data = [
      {
        sessionId: "abc-123",
        path: "abc.jsonl",
        created: "2025-01-01T00:00:00Z",
      },
      { sessionId: "no-path" }, // missing path and created
      { notASession: true },
      null,
    ];
    const result = parseSessionIndex(toBuffer(JSON.stringify(data)));
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe("abc-123");
  });

  it("returns empty array for non-array JSON", () => {
    const result = parseSessionIndex(
      toBuffer(JSON.stringify({ key: "value" }))
    );
    expect(result).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    const result = parseSessionIndex(toBuffer("not json at all"));
    expect(result).toEqual([]);
  });
});

// ---------- parseConversationJsonl ----------

describe("parseConversationJsonl", () => {
  it("parses user and assistant messages", () => {
    const jsonl = makeJsonlLines([
      { role: "user", content: "Hello", timestamp: "2025-01-01T00:00:00Z" },
      {
        role: "assistant",
        content: "Hi there",
        timestamp: "2025-01-01T00:00:01Z",
      },
    ]);
    const result = parseConversationJsonl(toBuffer(jsonl));
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("user");
    expect(result[0]!.content).toBe("Hello");
    expect(result[1]!.role).toBe("assistant");
  });

  it("filters out non-user/assistant roles", () => {
    const jsonl = makeJsonlLines([
      { role: "user", content: "Hello", timestamp: "2025-01-01T00:00:00Z" },
      {
        role: "system",
        content: "System msg",
        timestamp: "2025-01-01T00:00:01Z",
      },
      {
        role: "progress",
        content: "Loading...",
        timestamp: "2025-01-01T00:00:02Z",
      },
    ]);
    const result = parseConversationJsonl(toBuffer(jsonl));
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("user");
  });

  it("normalizes array content blocks into text", () => {
    const jsonl = makeJsonlLines([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Part one" },
          { type: "tool_use", name: "Read", id: "t1", input: {} },
          { type: "text", text: "Part two" },
        ],
        timestamp: "2025-01-01T00:00:00Z",
      },
    ]);
    const result = parseConversationJsonl(toBuffer(jsonl));
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("Part one\nPart two");
  });

  it("extracts tool calls from content blocks", () => {
    const jsonl = makeJsonlLines([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check" },
          {
            type: "tool_use",
            id: "tu-1",
            name: "Read",
            input: { file: "test.ts" },
          },
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: "file contents here",
          },
        ],
        timestamp: "2025-01-01T00:00:00Z",
      },
    ]);
    const result = parseConversationJsonl(toBuffer(jsonl));
    expect(result[0]!.toolCalls).toHaveLength(1);
    expect(result[0]!.toolCalls![0]!.name).toBe("Read");
    expect(result[0]!.toolCalls![0]!.input).toEqual({ file: "test.ts" });
    expect(result[0]!.toolCalls![0]!.result).toBe("file contents here");
  });

  it("truncates tool results exceeding limits", () => {
    const longResult = "x".repeat(15_000);
    const jsonl = makeJsonlLines([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu-1", name: "Bash", input: {} },
          { type: "tool_result", tool_use_id: "tu-1", content: longResult },
        ],
        timestamp: "2025-01-01T00:00:00Z",
      },
    ]);
    const result = parseConversationJsonl(toBuffer(jsonl));
    expect(result[0]!.toolCalls![0]!.result!.length).toBeLessThanOrEqual(
      10_000
    );
    expect(result[0]!.toolCalls![0]!.truncated).toBe(true);
  });

  it("handles entries with no toolCalls gracefully", () => {
    const jsonl = makeJsonlLines([
      {
        role: "user",
        content: "Just text",
        timestamp: "2025-01-01T00:00:00Z",
      },
    ]);
    const result = parseConversationJsonl(toBuffer(jsonl));
    expect(result[0]!.toolCalls).toBeUndefined();
  });

  it("skips malformed JSONL lines without crashing", () => {
    const content = [
      JSON.stringify({
        role: "user",
        content: "Valid",
        timestamp: "2025-01-01T00:00:00Z",
      }),
      "this is { not valid json",
      JSON.stringify({
        role: "assistant",
        content: "Also valid",
        timestamp: "2025-01-01T00:00:01Z",
      }),
    ].join("\n");
    const result = parseConversationJsonl(toBuffer(content));
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty buffer", () => {
    const result = parseConversationJsonl(Buffer.alloc(0));
    expect(result).toEqual([]);
  });
});

// ---------- deriveAgentLabel ----------

describe("deriveAgentLabel", () => {
  it("extracts known command names from <command-name> tags", () => {
    expect(
      deriveAgentLabel(
        "Some preamble <command-name>/code:code</command-name> rest"
      )
    ).toBe("Orchestrator");

    expect(deriveAgentLabel("<command-name>plan-writer</command-name>")).toBe(
      "Plan Writer"
    );

    expect(
      deriveAgentLabel("<command-name>implementation-subagent</command-name>")
    ).toBe("Implementation");

    expect(
      deriveAgentLabel("<command-name>verification-subagent</command-name>")
    ).toBe("Verification");
  });

  it("returns raw command name for unknown patterns", () => {
    expect(deriveAgentLabel("<command-name>custom-agent</command-name>")).toBe(
      "custom-agent"
    );
  });

  it("falls back to truncated first prompt when no command-name tag", () => {
    const shortPrompt = "Do something";
    expect(deriveAgentLabel(shortPrompt)).toBe("Do something");

    const longPrompt = "A".repeat(100);
    const result = deriveAgentLabel(longPrompt);
    expect(result).toBe(`${"A".repeat(50)}...`);
  });
});

// ---------- buildExecutionTrace ----------

describe("buildExecutionTrace", () => {
  it("aggregates stats across multiple sessions", () => {
    const sessions = [
      {
        sessionId: "s1",
        agentLabel: "Orchestrator",
        parentSessionId: null,
        entries: [
          {
            role: "user" as const,
            content: "Go",
            timestamp: "2025-01-01T00:00:00Z",
          },
          {
            role: "assistant" as const,
            content: "Done",
            timestamp: "2025-01-01T00:01:00Z",
            toolCalls: [{ name: "Read", input: {}, result: null }],
          },
        ],
        stats: { messageCount: 2, toolCallCount: 1, duration: 60_000 },
      },
      {
        sessionId: "s2",
        agentLabel: "Implementation",
        parentSessionId: null,
        entries: [
          {
            role: "user" as const,
            content: "Build",
            timestamp: "2025-01-01T00:02:00Z",
          },
        ],
        stats: { messageCount: 1, toolCallCount: 0, duration: null },
      },
    ];

    const trace = buildExecutionTrace(sessions);
    expect(trace.totalSessions).toBe(2);
    expect(trace.totalMessages).toBe(3);
    expect(trace.totalToolCalls).toBe(1);
    // Overall duration from earliest (00:00:00) to latest (00:02:00) = 120s
    expect(trace.overallDuration).toBe(120_000);
  });

  it("returns null duration for empty sessions", () => {
    const trace = buildExecutionTrace([]);
    expect(trace.overallDuration).toBeNull();
    expect(trace.totalSessions).toBe(0);
  });
});

// ---------- createEmptyExecutionTrace ----------

describe("createEmptyExecutionTrace", () => {
  it("returns a trace with all zero values", () => {
    const trace = createEmptyExecutionTrace();
    expect(trace).toEqual({
      sessions: [],
      totalSessions: 0,
      totalMessages: 0,
      totalToolCalls: 0,
      overallDuration: null,
    });
  });
});

// ---------- parseExecutionLogs (integration) ----------

describe("parseExecutionLogs", () => {
  it("parses a zip with sessions-index.json and session files", () => {
    const sessionContent = makeJsonlLines([
      {
        role: "user",
        content: "<command-name>/code:code</command-name> Build a feature",
        timestamp: "2025-01-01T00:00:00Z",
      },
      {
        role: "assistant",
        content: "On it.",
        timestamp: "2025-01-01T00:00:30Z",
      },
    ]);

    const zipBuffer = buildConversationZip({
      indexEntries: [
        {
          sessionId: "sess-1",
          path: ".claude/runs/conversations/sess-1.jsonl",
          created: "2025-01-01T00:00:00Z",
        },
      ],
      files: [
        {
          path: ".claude/runs/conversations/sess-1.jsonl",
          content: sessionContent,
        },
      ],
    });

    const trace = parseExecutionLogs(zipBuffer);
    expect(trace.totalSessions).toBe(1);
    expect(trace.totalMessages).toBe(2);
    expect(trace.sessions[0]!.agentLabel).toBe("Orchestrator");
    expect(trace.sessions[0]!.sessionId).toBe("sess-1");
  });

  it("falls back to directory scan when sessions-index.json is absent", () => {
    const sessionContent = makeJsonlLines([
      {
        role: "user",
        content: "Hello",
        timestamp: "2025-01-01T00:00:00Z",
      },
    ]);

    const zipBuffer = buildConversationZip({
      files: [
        {
          path: ".claude/runs/conversations/abc-123.jsonl",
          content: sessionContent,
        },
      ],
    });

    const trace = parseExecutionLogs(zipBuffer);
    expect(trace.totalSessions).toBe(1);
    expect(trace.sessions[0]!.sessionId).toBe("abc-123");
  });

  it("skips empty session files", () => {
    const zipBuffer = buildConversationZip({
      indexEntries: [
        {
          sessionId: "empty-sess",
          path: ".claude/runs/conversations/empty-sess.jsonl",
          created: "2025-01-01T00:00:00Z",
        },
      ],
      files: [
        {
          path: ".claude/runs/conversations/empty-sess.jsonl",
          content: "",
        },
      ],
    });

    const trace = parseExecutionLogs(zipBuffer);
    expect(trace.totalSessions).toBe(0);
  });

  it("returns empty trace for invalid zip buffer", () => {
    const trace = parseExecutionLogs(Buffer.from("not a zip"));
    expect(trace).toEqual(createEmptyExecutionTrace());
  });

  it("handles multiple sessions with tool calls", () => {
    const orchestratorContent = makeJsonlLines([
      {
        role: "user",
        content: "<command-name>/code:code</command-name> Implement feature",
        timestamp: "2025-01-01T00:00:00Z",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading files" },
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file: "index.ts" },
          },
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "export default {}",
          },
        ],
        timestamp: "2025-01-01T00:00:10Z",
      },
    ]);

    const implContent = makeJsonlLines([
      {
        role: "user",
        content:
          "<command-name>implementation-subagent</command-name> Write code",
        timestamp: "2025-01-01T00:01:00Z",
      },
      {
        role: "assistant",
        content: "Done writing code",
        timestamp: "2025-01-01T00:02:00Z",
      },
    ]);

    const zipBuffer = buildConversationZip({
      indexEntries: [
        {
          sessionId: "orch-1",
          path: ".claude/runs/conversations/orch-1.jsonl",
          created: "2025-01-01T00:00:00Z",
        },
        {
          sessionId: "impl-1",
          path: ".claude/runs/conversations/impl-1.jsonl",
          created: "2025-01-01T00:01:00Z",
        },
      ],
      files: [
        {
          path: ".claude/runs/conversations/orch-1.jsonl",
          content: orchestratorContent,
        },
        {
          path: ".claude/runs/conversations/impl-1.jsonl",
          content: implContent,
        },
      ],
    });

    const trace = parseExecutionLogs(zipBuffer);
    expect(trace.totalSessions).toBe(2);
    expect(trace.totalMessages).toBe(4);
    expect(trace.totalToolCalls).toBe(1);
    expect(trace.sessions[0]!.agentLabel).toBe("Orchestrator");
    expect(trace.sessions[1]!.agentLabel).toBe("Implementation");
    // Overall duration from earliest (00:00:00) to latest (00:02:00) = 120s
    expect(trace.overallDuration).toBe(120_000);
  });

  it("handles nested symphony-run.zip inside outer zip", () => {
    const sessionContent = makeJsonlLines([
      {
        role: "user",
        content: "<command-name>plan-writer</command-name> Write a plan",
        timestamp: "2025-01-01T00:00:00Z",
      },
      {
        role: "assistant",
        content: "Here is the plan.",
        timestamp: "2025-01-01T00:01:00Z",
      },
    ]);

    // Build inner zip with runs/conversations/ path (no .claude/ prefix)
    const innerZip = buildConversationZip({
      indexEntries: [
        {
          sessionId: "nested-sess",
          path: "runs/conversations/-home-runner-work-repo/nested-sess.jsonl",
          created: "2025-01-01T00:00:00Z",
        },
      ],
      indexPath: "runs/conversations/sessions-index.json",
      files: [
        {
          path: "runs/conversations/-home-runner-work-repo/nested-sess.jsonl",
          content: sessionContent,
        },
      ],
    });

    // Wrap in outer zip as symphony-run.zip
    const outerZipBuffer = buildNestedZip(innerZip);

    const trace = parseExecutionLogs(outerZipBuffer);
    expect(trace.totalSessions).toBe(1);
    expect(trace.totalMessages).toBe(2);
    expect(trace.sessions[0]!.sessionId).toBe("nested-sess");
    expect(trace.sessions[0]!.agentLabel).toBe("Plan Writer");
  });

  it("parses conversation files with runs/conversations/ path (no .claude/ prefix)", () => {
    const sessionContent = makeJsonlLines([
      {
        role: "user",
        content: "Hello",
        timestamp: "2025-01-01T00:00:00Z",
      },
    ]);

    // Flat zip with non-.claude/ prefixed paths
    const zipBuffer = buildConversationZip({
      files: [
        {
          path: "runs/conversations/-home-runner-work-repo/abc-123.jsonl",
          content: sessionContent,
        },
      ],
    });

    const trace = parseExecutionLogs(zipBuffer);
    expect(trace.totalSessions).toBe(1);
    expect(trace.sessions[0]!.sessionId).toBe("abc-123");
  });

  it("still parses old .claude/runs/conversations/ paths (backward compat)", () => {
    const sessionContent = makeJsonlLines([
      {
        role: "user",
        content: "Hello",
        timestamp: "2025-01-01T00:00:00Z",
      },
    ]);

    const zipBuffer = buildConversationZip({
      files: [
        {
          path: ".claude/runs/conversations/legacy-sess.jsonl",
          content: sessionContent,
        },
      ],
    });

    const trace = parseExecutionLogs(zipBuffer);
    expect(trace.totalSessions).toBe(1);
    expect(trace.sessions[0]!.sessionId).toBe("legacy-sess");
  });
});
