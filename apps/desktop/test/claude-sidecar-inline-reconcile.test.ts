/**
 * @file claude-sidecar-inline-reconcile.test.ts
 * @description ISS-11281: pins how the Claude parser reconciles a tool call
 * recorded BOTH inline (an `isSidechain` entry in the parent transcript) and in
 * the agent's `subagents/agent-*.jsonl` sidecar — which completion evidence
 * wins, which disagreements turn the call into a conflict that is removed from
 * the subagent row and the session alike.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { parseSessionFile } from "../src/main/collectors/claude/claude-parser.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

const AGENT = "agent-reconcile";
const T0 = "2024-03-09T16:00:00.000Z";
const T1 = "2024-03-09T16:00:01.000Z";
const T2 = "2024-03-09T16:00:02.000Z";

type Json = Record<string, unknown>;

function toolUse(id: string, filePath = "a.ts"): Json {
  return { type: "tool_use", id, name: "Read", input: { file_path: filePath } };
}

function toolResult(id: string, content: string, isError?: boolean): Json {
  return {
    type: "tool_result",
    tool_use_id: id,
    content,
    ...(isError === undefined ? {} : { is_error: isError }),
  };
}

function inlineCall(blocks: Json[]): Json {
  return {
    type: "assistant",
    timestamp: T0,
    uuid: AGENT,
    isSidechain: true,
    message: { role: "assistant", content: blocks },
  };
}

function inlineResult(blocks: Json[], timestamp = T1): Json {
  return {
    type: "user",
    timestamp,
    uuid: `r-${timestamp}`,
    parentUuid: AGENT,
    isSidechain: true,
    message: { role: "user", content: blocks },
  };
}

function sidecarCall(blocks: Json[]): Json {
  return { type: "assistant", timestamp: T0, message: { content: blocks } };
}

function sidecarResult(blocks: Json[], timestamp = T1): Json {
  return { type: "user", timestamp, message: { content: blocks } };
}

const toJsonl = (lines: Json[]): string =>
  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

async function parse(
  parentLines: Json[],
  sidecarLines: Json[]
): Promise<NormalizedSession | null> {
  const dir = makeTempDir("claude-reconcile-");
  const sessionId = "claude-reconcile";
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, toJsonl(parentLines), "utf8");
  const subagentsDir = path.join(dir, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(
    path.join(subagentsDir, `${AGENT}.jsonl`),
    toJsonl(sidecarLines),
    "utf8"
  );
  return await parseSessionFile(filePath);
}

/** Throws rather than asserting so the helper stays assertion-free. */
function agentToolUses(parsed: NormalizedSession | null) {
  const agent = parsed?.subagents?.find((subagent) => subagent.id === AGENT);
  if (!agent) {
    throw new Error("expected a parsed transcript carrying the sidecar agent");
  }
  return (agent.toolUses ?? []).map((t) => ({
    id: t.id,
    output: t.output,
    resultTimestamp: t.resultTimestamp,
    isError: t.isError,
  }));
}

describe("inline vs sidecar completion evidence", () => {
  it("merges matching completions, taking the sidecar's error flag when the inline one is absent", async () => {
    const parsed = await parse(
      [inlineCall([toolUse("t1")]), inlineResult([toolResult("t1", "same")])],
      [
        sidecarCall([toolUse("t1")]),
        sidecarResult([toolResult("t1", "same", false)]),
      ]
    );
    assert.deepEqual(agentToolUses(parsed), [
      { id: "t1", output: "same", resultTimestamp: T1, isError: false },
    ]);
  });

  it("keeps the inline completion when the sidecar recorded only the call", async () => {
    const parsed = await parse(
      [
        inlineCall([toolUse("t1")]),
        inlineResult([toolResult("t1", "inline-out", true)]),
      ],
      [sidecarCall([toolUse("t1")])]
    );
    assert.deepEqual(agentToolUses(parsed), [
      { id: "t1", output: "inline-out", resultTimestamp: T1, isError: true },
    ]);
  });

  it("takes the sidecar completion when the inline record has only the call", async () => {
    const parsed = await parse(
      [inlineCall([toolUse("t1")])],
      [
        sidecarCall([toolUse("t1")]),
        sidecarResult([toolResult("t1", "sidecar-out", true)], T2),
      ]
    );
    assert.deepEqual(agentToolUses(parsed), [
      { id: "t1", output: "sidecar-out", resultTimestamp: T2, isError: true },
    ]);
  });
});

describe("inline vs sidecar conflicts", () => {
  const T2_CALL = toolUse("t2", "b.ts");

  /** Tool-use ids on the agent row and on the session, for the two projections a conflict must leave. */
  function projections(parsed: NormalizedSession | null) {
    return {
      agent: agentToolUses(parsed).map((t) => t.id),
      session: (parsed?.toolUses ?? []).map((t) => t.id),
    };
  }

  it("keeps an agreeing call on both the agent row and the session", async () => {
    const parsed = await parse(
      [
        inlineCall([toolUse("t1"), T2_CALL]),
        inlineResult([toolResult("t1", "out", false)]),
      ],
      [
        sidecarCall([toolUse("t1")]),
        sidecarResult([toolResult("t1", "out", false)]),
      ]
    );
    assert.deepEqual(projections(parsed), {
      agent: ["t1", "t2"],
      session: ["t1", "t2"],
    });
  });

  it("drops a call whose two completions disagree on is_error, from the agent row and the session", async () => {
    const parsed = await parse(
      [
        inlineCall([toolUse("t1"), T2_CALL]),
        inlineResult([toolResult("t1", "out", false)]),
      ],
      [
        sidecarCall([toolUse("t1")]),
        sidecarResult([toolResult("t1", "out", true)]),
      ]
    );
    assert.deepEqual(projections(parsed), { agent: ["t2"], session: ["t2"] });
  });

  it("drops a call whose two completions disagree on output or result time, from both projections", async () => {
    const byOutput = await parse(
      [
        inlineCall([toolUse("t1"), T2_CALL]),
        inlineResult([toolResult("t1", "one")]),
      ],
      [sidecarCall([toolUse("t1")]), sidecarResult([toolResult("t1", "two")])]
    );
    assert.deepEqual(projections(byOutput), { agent: ["t2"], session: ["t2"] });

    const byTime = await parse(
      [
        inlineCall([toolUse("t1"), T2_CALL]),
        inlineResult([toolResult("t1", "same")], T1),
      ],
      [
        sidecarCall([toolUse("t1")]),
        sidecarResult([toolResult("t1", "same")], T2),
      ]
    );
    assert.deepEqual(projections(byTime), { agent: ["t2"], session: ["t2"] });
  });

  it("drops a call whose input differs between the two records, from both projections", async () => {
    const parsed = await parse(
      [inlineCall([toolUse("t1", "a.ts"), T2_CALL])],
      [sidecarCall([toolUse("t1", "other.ts")])]
    );
    assert.deepEqual(projections(parsed), { agent: ["t2"], session: ["t2"] });
  });
});

describe("inline vs sidecar identity and merge order", () => {
  it("keeps a call both sides completed as an error, with the error flag set", async () => {
    const parsed = await parse(
      [
        inlineCall([toolUse("t1")]),
        inlineResult([toolResult("t1", "boom", true)]),
      ],
      [
        sidecarCall([toolUse("t1")]),
        sidecarResult([toolResult("t1", "boom", true)]),
      ]
    );
    assert.deepEqual(agentToolUses(parsed), [
      { id: "t1", output: "boom", resultTimestamp: T1, isError: true },
    ]);
  });

  it("drops a call whose tool name or call time differs between the two records", async () => {
    const renamed = await parse(
      [inlineCall([toolUse("t1"), toolUse("t2", "b.ts")])],
      [
        sidecarCall([
          {
            type: "tool_use",
            id: "t1",
            name: "Glob",
            input: { file_path: "a.ts" },
          },
        ]),
      ]
    );
    assert.deepEqual(
      agentToolUses(renamed).map((t) => t.id),
      ["t2"]
    );

    const retimed = await parse(
      [inlineCall([toolUse("t1"), toolUse("t2", "b.ts")])],
      [{ ...sidecarCall([toolUse("t1")]), timestamp: T2 }]
    );
    assert.deepEqual(
      agentToolUses(retimed).map((t) => t.id),
      ["t2"]
    );
  });

  it("re-indexes after a conflict so a later sidecar call still completes its own inline record", async () => {
    const parsed = await parse(
      [
        inlineCall([
          toolUse("t1"),
          toolUse("t2", "b.ts"),
          toolUse("t3", "c.ts"),
        ]),
      ],
      [
        sidecarCall([toolUse("t1", "other.ts"), toolUse("t3", "c.ts")]),
        sidecarResult([toolResult("t3", "third")]),
      ]
    );
    assert.deepEqual(agentToolUses(parsed), [
      {
        id: "t2",
        output: undefined,
        resultTimestamp: undefined,
        isError: undefined,
      },
      { id: "t3", output: "third", resultTimestamp: T1, isError: undefined },
    ]);
  });

  it("appends a sidecar-only call to the agent row", async () => {
    const parsed = await parse(
      [inlineCall([toolUse("t1")])],
      [sidecarCall([toolUse("t1"), toolUse("s1", "sidecar.ts")])]
    );
    assert.deepEqual(
      agentToolUses(parsed).map((t) => t.id),
      ["t1", "s1"]
    );
  });
});
