/**
 * ISS-12552: the Codex and OpenCode folds list every subagent tool use twice,
 * in `subagent.toolUses` and in `root.toolUses`, with no `id`. Each call must
 * yield exactly one tool invocation candidate, on the in-process path (shared
 * objects) and across the historical parse worker boundary (the response
 * clamp, which turns an input value holding `undefined` into the truncation
 * marker, then a structured clone and the response schema's re-validation,
 * which builds new objects).
 */
import "./support/attribution-parse-policy.js";
import type {
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolUse,
} from "@repo/lib/harness/types";
import { describe, expect, it } from "vitest";
import {
  clampSessionPayloads,
  TRUNCATED_UNKNOWN_VALUE,
} from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";
import { normalizedSessionSchema } from "../src/main/collectors/engine/historical-parse-worker-session-schema.js";
import { foldOpencodeSubagents } from "../src/main/collectors/opencode/opencode-subagent-fold.js";
import { collectToolCandidates } from "../src/main/database/component-invocation-tool-candidates.js";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { makeSession } from "./normalized-session-test-utils.js";

const SUBAGENT_ID = "019ea895-63c1-7f33-8b0d-5e3a143d032e";
const AT = "2026-06-08T18:55:26.322Z";

describe("folded subagent tool uses yield one candidate per call (ISS-12552)", () => {
  it("counts a folded exec call and a folded MCP call once each, beside the root's own call", () => {
    const session = codexShapedSession([
      rootOwn("exec_command", { cmd: "ls" }),
      folded("exec_command", { cmd: "pwd" }),
      folded("search_code", { query: "x" }, "call_2LVA1Yg3kjqtbBQLYDVtMpYR"),
    ]);

    expect(namesOf(session)).toEqual([
      "exec_command",
      "exec_command",
      "search_code",
    ]);
  });

  it("still counts each call once after the worker boundary rebuilds every object", () => {
    const session = codexShapedSession([
      rootOwn("exec_command", { cmd: "ls" }),
      folded("exec_command", { cmd: "pwd", env: undefined }),
      folded("search_code", { query: "x" }, "call_2LVA1Yg3kjqtbBQLYDVtMpYR"),
    ]);
    const acrossWorker = normalizedSessionSchema.parse(
      structuredClone(clampSessionPayloads(session))
    );

    expect(acrossWorker.toolUses[1]).not.toBe(
      acrossWorker.subagents?.[0]?.toolUses?.[0]
    );
    expect(acrossWorker.subagents?.[0]?.toolUses?.[0]?.input).toEqual({
      cmd: "pwd",
      env: TRUNCATED_UNKNOWN_VALUE,
    });
    expect(namesOf(acrossWorker)).toEqual([
      "exec_command",
      "exec_command",
      "search_code",
    ]);
  });

  it("keeps two identical parallel calls as two", () => {
    const first = folded("exec_command", { cmd: "pwd" });
    const second = folded("exec_command", { cmd: "pwd" });
    const session = codexShapedSession([first, second]);

    expect(namesOf(session)).toEqual(["exec_command", "exec_command"]);
  });

  it("keeps a second identical subagent call the root holds only one folded copy of", () => {
    const call = folded("exec_command", { cmd: "pwd" });
    const session = makeSession({
      toolUses: [call],
      subagents: [subagent([{ ...call }, { ...call }])],
    });

    expect(namesOf(session)).toEqual(["exec_command", "exec_command"]);
    expect(
      deriveAgentComponentInvocationCandidates(session, "main-agent", AT)
        .filter((candidate) => candidate.componentKey === "exec_command")
        .map((candidate) => candidate.componentKey)
    ).toEqual(["exec_command", "exec_command"]);
  });

  it("yields one candidate per child call after the real OpenCode fold", () => {
    const root = makeSession({
      sessionId: "opencode-ses_root",
      toolUses: [rootOwn("bash", { command: "ls" })],
    });
    const child = makeSession({
      sessionId: "opencode-ses_child",
      toolUses: [
        { name: "read", timestamp: AT, input: { filePath: "a.ts" } },
        { name: "bash", timestamp: AT, input: { command: "pwd" } },
      ],
    });
    const [foldedRoot] = foldOpencodeSubagents(
      [root, child],
      [
        { sessionId: "ses_root", parentId: null },
        { sessionId: "ses_child", parentId: "ses_root" },
      ]
    );
    if (!foldedRoot) {
      throw new Error("the fold returned no root");
    }

    expect(foldedRoot.subagents?.[0]?.toolUses).toHaveLength(2);
    expect(
      deriveAgentComponentInvocationCandidates(foldedRoot, "main-agent", AT)
        .map((candidate) => candidate.componentKey)
        .filter((key) => key === "bash" || key === "read")
        .sort()
    ).toEqual(["bash", "bash", "read"]);
  });

  it("never lets a root call of its own absorb a subagent call", () => {
    const own = rootOwn("exec_command", { cmd: "pwd" });
    const subagentCall: NormalizedToolUse = {
      ...own,
      subagentId: SUBAGENT_ID,
    };
    const session = makeSession({
      toolUses: [own],
      subagents: [subagent([subagentCall])],
    });

    expect(namesOf(session)).toEqual(["exec_command", "exec_command"]);
  });

  it("keeps a sidecar-only subagent call the root does not hold", () => {
    const session = makeSession({
      toolUses: [],
      subagents: [
        subagent([
          { id: "toolu_nested", name: "Read", timestamp: AT },
          { name: "exec_command", timestamp: AT, subagentId: SUBAGENT_ID },
        ]),
      ],
    });

    expect(namesOf(session)).toEqual(["Read", "exec_command"]);
  });

  it("leaves a Claude subagent call with an id to the id rule", () => {
    const call: NormalizedToolUse = {
      id: "toolu_shared",
      name: "Read",
      timestamp: AT,
    };
    const session = makeSession({
      toolUses: [call],
      subagents: [subagent([{ ...call }])],
    });

    expect(namesOf(session)).toEqual(["Read"]);
  });

  it("reaches the production derivation", () => {
    const session = codexShapedSession([
      folded("exec_command", { cmd: "pwd" }),
    ]);
    const tools = deriveAgentComponentInvocationCandidates(
      session,
      "main-agent",
      AT
    ).filter((candidate) => candidate.componentKey === "exec_command");

    expect(tools).toHaveLength(1);
  });
});

/** The fold's shape: folded calls in the root list and their subagent's list. */
function codexShapedSession(
  rootToolUses: NormalizedToolUse[]
): NormalizedSession {
  return makeSession({
    toolUses: rootToolUses,
    subagents: [subagent(rootToolUses.filter((toolUse) => toolUse.subagentId))],
  });
}

function subagent(toolUses: NormalizedToolUse[]): NormalizedSubagent {
  return {
    id: SUBAGENT_ID,
    name: "explorer",
    status: "completed",
    toolUses,
  };
}

function rootOwn(name: string, input: unknown): NormalizedToolUse {
  return { name, timestamp: AT, input };
}

function folded(
  name: string,
  input: unknown,
  providerToolUseId?: string
): NormalizedToolUse {
  return {
    name,
    timestamp: AT,
    input,
    subagentId: SUBAGENT_ID,
    ...(providerToolUseId ? { providerToolUseId } : {}),
  };
}

function namesOf(session: NormalizedSession): string[] {
  return collectToolCandidates(session, (toolUse) => toolUse.name);
}
