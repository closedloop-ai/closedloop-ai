/**
 * @file parse-claude-footprint-capture.test.ts
 * @description ISS-10736: the parser is where a component's CONTEXT FOOTPRINT
 * has to be counted, because it is the last place the whole injected text still
 * exists. `toolUse.output` is byte-capped at 4096 by `truncateText`, and a hook's
 * stdout never crosses the worker boundary at all, so a count taken downstream
 * would under-state the real injection systematically rather than sample it.
 *
 * These cases exist because nothing else executes these three lines: every suite
 * below the parser injects the counts into its own fixture, so deleting the
 * production assignments would restore the zero-footprint bug with the rest of
 * the suite green.
 */

import { estimateAgentComponentFootprintTokens } from "@repo/api/src/types/agent-component-footprint";
import { describe, expect, it } from "vitest";
import { parseCursorTranscript } from "../cursor/parse-cursor";
import { parseClaudeTranscript } from "./parse-claude";

const TS = "2026-09-23T12:00:00.000Z";
/* Comfortably past `truncateText`'s 4096-byte cap, so the stored `output` is a
   strict prefix and a count over it cannot equal the count over the whole. */
const HUGE_RESULT = "x".repeat(20_000);

function lines(...records: unknown[]): string[] {
  return records.map((record) => JSON.stringify(record));
}

async function parse(records: unknown[]) {
  return await parseClaudeTranscript(lines(...records), {
    sessionId: "footprint-session",
  });
}

const TOOL_CALL = {
  type: "assistant",
  timestamp: TS,
  cwd: "/workspace/project",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_big",
        name: "Read",
        input: { file_path: "/workspace/project/big.txt" },
      },
    ],
  },
};

const TOOL_RESULT = {
  type: "user",
  timestamp: TS,
  cwd: "/workspace/project",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_big",
        content: HUGE_RESULT,
      },
    ],
  },
};

describe("ISS-10736 parse-time footprint capture", () => {
  it("counts a tool result over the WHOLE payload, not the stored prefix", async () => {
    const session = await parse([TOOL_CALL, TOOL_RESULT]);
    const toolUse = session?.toolUses.find((use) => use.id === "toolu_big");

    expect(toolUse?.outputFootprintTokens).toBe(
      estimateAgentComponentFootprintTokens(HUGE_RESULT)
    );
    // The stored payload is a capped prefix, so a count over it is strictly
    // smaller — which is exactly the under-statement this field exists to avoid.
    const stored = String(toolUse?.output ?? "");
    expect(stored.length).toBeLessThan(HUGE_RESULT.length);
    expect(estimateAgentComponentFootprintTokens(stored)).toBeLessThan(
      toolUse?.outputFootprintTokens ?? 0
    );
  });

  it("leaves the count absent when a call's result never arrived", async () => {
    const session = await parse([TOOL_CALL]);
    const toolUse = session?.toolUses.find((use) => use.id === "toolu_big");

    expect(toolUse).toBeDefined();
    expect(toolUse?.outputFootprintTokens).toBeUndefined();
  });

  it("counts a hook firing's stdout", async () => {
    const stdout = "hook said this\n".repeat(50);
    const session = await parse([
      {
        type: "user",
        timestamp: TS,
        cwd: "/workspace/project",
        message: { role: "user", content: "go" },
      },
      {
        type: "attachment",
        timestamp: TS,
        cwd: "/workspace/project",
        attachment: {
          type: "hook_success",
          hookName: "SessionStart:startup",
          hookEvent: "SessionStart",
          command: "node hook.js",
          stdout,
          exitCode: 0,
        },
      },
    ]);
    const hook = session?.hooks.find(
      (entry) => entry.name === "SessionStart:startup"
    );

    expect(hook?.stdoutFootprintTokens).toBe(
      estimateAgentComponentFootprintTokens(stdout)
    );
  });

  it("leaves the hook count absent when the firing printed nothing", async () => {
    const session = await parse([
      {
        type: "user",
        timestamp: TS,
        cwd: "/workspace/project",
        message: { role: "user", content: "go" },
      },
      {
        type: "attachment",
        timestamp: TS,
        cwd: "/workspace/project",
        attachment: {
          type: "hook_success",
          hookName: "SessionStart:quiet",
          hookEvent: "SessionStart",
          command: "node quiet.js",
          exitCode: 0,
        },
      },
    ]);
    const hook = session?.hooks.find(
      (entry) => entry.name === "SessionStart:quiet"
    );

    expect(hook).toBeDefined();
    expect(hook?.stdoutFootprintTokens).toBeUndefined();
  });
});

/**
 * The Cursor lane counts the same way and at the same seam, and is a second
 * harness rather than a second code path worth trusting on the Claude lane's
 * coverage: `parse-cursor.ts` has its own `truncateText` call, so its footprint
 * is under-stated by exactly the same mechanism if the count is not taken above
 * the cap.
 */
describe("ISS-10736 parse-time footprint capture, Cursor lane", () => {
  it("counts a cursor tool result over the WHOLE payload", async () => {
    const session = await parseCursorTranscript(
      [
        JSON.stringify({
          type: "tool_call",
          timestamp: TS,
          payload: { name: "Read" },
        }),
        JSON.stringify({
          type: "tool_result",
          timestamp: TS,
          payload: { output: HUGE_RESULT },
        }),
      ],
      { sessionId: "cursor-footprint-session" }
    );
    const toolUse = session?.toolUses[0];

    expect(toolUse?.outputFootprintTokens).toBe(
      estimateAgentComponentFootprintTokens(HUGE_RESULT)
    );
    const stored = String(toolUse?.output ?? "");
    expect(stored.length).toBeLessThan(HUGE_RESULT.length);
    expect(estimateAgentComponentFootprintTokens(stored)).toBeLessThan(
      toolUse?.outputFootprintTokens ?? 0
    );
  });

  it("leaves the cursor count absent when no result arrived", async () => {
    const session = await parseCursorTranscript(
      [
        JSON.stringify({
          type: "tool_call",
          timestamp: TS,
          payload: { name: "Read" },
        }),
      ],
      { sessionId: "cursor-no-result-session" }
    );

    expect(session?.toolUses[0]).toBeDefined();
    expect(session?.toolUses[0]?.outputFootprintTokens).toBeUndefined();
  });
});
