/**
 * @file claude-delegation-kickoff.test.ts
 * @description ISS-4592: the desktop sidecar lane of the delegation-kickoff
 * join — reading `agent-<hex>.meta.json`, resolving a nested delegation whose
 * kickoff lives in a sibling subagent's transcript, and degrading cleanly when
 * a source is missing or stale.
 *
 * The core (browser-safe) half of the join is covered by
 * `packages/lib/harness/claude/parse-claude-delegations.test.ts`; this file
 * only exercises what needs local disk.
 *
 * Transcripts are written inline here rather than through
 * `writeClaudeTranscript`, because these cases need sidecar `.meta.json`
 * companions and (for the CRLF case) a line separator the shared helper
 * hardcodes to "\n".
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseSessionFile } from "../src/main/collectors/claude/claude-parser.js";

const PARENT_TS = "2026-06-07T10:00:00.000Z";
const CHILD_HEX = "a7bb59fb7a25cac2e";

type SidecarSpec = {
  hex: string;
  lines: unknown[];
  meta?: Record<string, unknown>;
  /** Nests the sidecar under `subagents/workflows/<workflow>/` (FEA-3420). */
  workflow?: string;
};

/**
 * Write a parent transcript plus sidecar subagent transcripts and their
 * `.meta.json` companions. `eol` is a parameter so one payload can be written
 * in both LF and CRLF form.
 */
function writeSession(options: {
  sessionId: string;
  lines: unknown[];
  sidecars?: SidecarSpec[];
  eol?: string;
}): string {
  const eol = options.eol ?? "\n";
  const projDir = mkdtempSync(path.join(os.tmpdir(), "claude-deleg-"));
  const filePath = path.join(projDir, `${options.sessionId}.jsonl`);
  writeFileSync(
    filePath,
    `${options.lines.map((line) => JSON.stringify(line)).join(eol)}${eol}`,
    "utf8"
  );
  if (options.sidecars?.length) {
    const subDir = path.join(projDir, options.sessionId, "subagents");
    mkdirSync(subDir, { recursive: true });
    for (const sidecar of options.sidecars) {
      const dir = sidecar.workflow
        ? path.join(subDir, "workflows", sidecar.workflow)
        : subDir;
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, `agent-${sidecar.hex}.jsonl`),
        `${sidecar.lines.map((line) => JSON.stringify(line)).join(eol)}${eol}`,
        "utf8"
      );
      if (sidecar.meta) {
        writeFileSync(
          path.join(dir, `agent-${sidecar.hex}.meta.json`),
          JSON.stringify(sidecar.meta, null, 2),
          "utf8"
        );
      }
    }
  }
  return filePath;
}

function userLine(): unknown {
  return { type: "user", timestamp: PARENT_TS, cwd: "/test" };
}

function delegationLine(options: {
  toolUseId: string;
  type?: string;
  prompt?: string;
  description?: string;
  toolName?: string;
  timestamp?: string;
  sidechainOf?: string;
}): unknown {
  const input: Record<string, unknown> = {};
  if (options.description != null) {
    input.description = options.description;
  }
  if (options.type != null) {
    input.subagent_type = options.type;
  }
  if (options.prompt != null) {
    input.prompt = options.prompt;
  }
  return {
    type: "assistant",
    timestamp: options.timestamp ?? "2026-06-07T10:00:01.000Z",
    ...(options.sidechainOf
      ? { isSidechain: true, agentId: options.sidechainOf }
      : {}),
    message: {
      id: `msg_${options.toolUseId}`,
      model: "claude-opus-4-5",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: options.toolUseId,
          name: options.toolName ?? "Agent",
          input,
        },
      ],
    },
  };
}

function childToolLine(hex: string, toolUseId: string): unknown {
  return {
    type: "assistant",
    timestamp: "2026-06-07T10:00:05.000Z",
    isSidechain: true,
    agentId: hex,
    attributionAgent: "Explore",
    message: {
      id: `msg_${toolUseId}`,
      model: "claude-opus-4-5",
      role: "assistant",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Read",
          input: { file_path: "/repo/x.ts" },
        },
      ],
    },
  };
}

/** The answering tool_result line, whose `toolUseResult` names the child. */
function resultLine(options: {
  toolUseId: string;
  agentId: string;
  agentType?: string;
  prompt?: string;
}): unknown {
  const toolUseResult: Record<string, unknown> = {
    status: "completed",
    agentId: options.agentId,
  };
  if (options.agentType != null) {
    toolUseResult.agentType = options.agentType;
  }
  if (options.prompt != null) {
    toolUseResult.prompt = options.prompt;
  }
  return {
    type: "user",
    timestamp: "2026-06-07T10:00:09.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: options.toolUseId,
          content: [{ type: "text", text: "done" }],
        },
      ],
    },
    toolUseResult,
  };
}

function subagentOf(
  session: Awaited<ReturnType<typeof parseSessionFile>>,
  hex: string
) {
  return session?.subagents?.find((s) => s.id === `agent-${hex}`);
}

test("sidecar subagent carries its delegation kickoff from meta.json + tool_use input", async () => {
  const filePath = writeSession({
    sessionId: "sess-kickoff",
    lines: [
      userLine(),
      delegationLine({
        toolUseId: "toolu_kick",
        type: "Explore",
        prompt: "Find the dashboard bug",
        description: "Dashboard bug hunt",
      }),
    ],
    sidecars: [
      {
        hex: CHILD_HEX,
        lines: [childToolLine(CHILD_HEX, "toolu_child")],
        meta: {
          agentType: "Explore",
          description: "Dashboard bug hunt",
          toolUseId: "toolu_kick",
        },
      },
    ],
  });

  const child = subagentOf(await parseSessionFile(filePath), CHILD_HEX);
  assert.equal(child?.type, "Explore");
  assert.equal(child?.task, "Find the dashboard bug");
  assert.equal(child?.metadata?.spawnedByToolUseId, "toolu_kick");
  assert.equal(child?.metadata?.description, "Dashboard bug hunt");
});

test("a NESTED delegation resolves through its parent subagent's transcript", async () => {
  // The 16-of-18 shape in golden dossier f216298d: the child was spawned by
  // another SUBAGENT, so its kickoff tool_use is in that sibling sidecar, not
  // the parent transcript. The merged tool-use record cannot serve as the
  // source — subagent-scanner bounds inputs at 1000 JSON chars — so this also
  // pins that the raw sidecar line is what gets read.
  const parentHex = "aaaa1111bbbb2222";
  const nestedHex = "cccc3333dddd4444";
  const longPrompt = `Nested kickoff: ${"detail ".repeat(300)}`;

  const filePath = writeSession({
    sessionId: "sess-nested",
    lines: [
      userLine(),
      delegationLine({
        toolUseId: "toolu_outer",
        type: "general-purpose",
        prompt: "Outer kickoff",
        description: "Outer",
      }),
    ],
    sidecars: [
      {
        hex: parentHex,
        lines: [
          childToolLine(parentHex, "toolu_parent_read"),
          delegationLine({
            toolUseId: "toolu_nested",
            type: "code-reviewer",
            prompt: longPrompt,
            description: "Nested reviewer",
            sidechainOf: parentHex,
          }),
        ],
        meta: {
          agentType: "general-purpose",
          description: "Outer",
          toolUseId: "toolu_outer",
        },
      },
      {
        hex: nestedHex,
        lines: [childToolLine(nestedHex, "toolu_nested_read")],
        meta: {
          agentType: "code-reviewer",
          description: "Nested reviewer",
          toolUseId: "toolu_nested",
        },
      },
    ],
  });

  const nested = subagentOf(await parseSessionFile(filePath), nestedHex);
  assert.equal(nested?.type, "code-reviewer");
  assert.equal(
    nested?.task,
    longPrompt,
    "the nested kickoff prompt must survive in full, not be lost to the scanner's 1000-char input bound"
  );
  assert.equal(nested?.metadata?.spawnedByToolUseId, "toolu_nested");
});

test("a missing meta.json degrades to the sidecar's own attributionAgent", async () => {
  const filePath = writeSession({
    sessionId: "sess-no-meta",
    lines: [userLine()],
    sidecars: [
      { hex: CHILD_HEX, lines: [childToolLine(CHILD_HEX, "toolu_child")] },
    ],
  });

  const child = subagentOf(await parseSessionFile(filePath), CHILD_HEX);
  assert.equal(child?.type, "Explore", "attributionAgent is the last resort");
  assert.equal(child?.task ?? null, null, "no prompt is recoverable");
  assert.equal(child?.metadata?.spawnedByToolUseId ?? null, null);
});

test("a meta.json pointing at an unknown tool_use still yields type + description", async () => {
  const filePath = writeSession({
    sessionId: "sess-dangling",
    lines: [userLine()],
    sidecars: [
      {
        hex: CHILD_HEX,
        lines: [childToolLine(CHILD_HEX, "toolu_child")],
        meta: {
          agentType: "test-engineer",
          description: "Write tests",
          toolUseId: "toolu_not_in_this_transcript",
        },
      },
    ],
  });

  const child = subagentOf(await parseSessionFile(filePath), CHILD_HEX);
  assert.equal(child?.type, "test-engineer");
  assert.equal(child?.metadata?.description, "Write tests");
  assert.equal(
    child?.task ?? null,
    null,
    "the prompt is genuinely unavailable"
  );
  // The FK is still recorded — a dangling pointer is provenance, not a lie.
  assert.equal(
    child?.metadata?.spawnedByToolUseId,
    "toolu_not_in_this_transcript"
  );
});

test("a corrupt meta.json is fail-silent, never fatal", async () => {
  const filePath = writeSession({
    sessionId: "sess-corrupt-meta",
    lines: [userLine()],
    sidecars: [
      { hex: CHILD_HEX, lines: [childToolLine(CHILD_HEX, "toolu_child")] },
    ],
  });
  writeFileSync(
    path.join(
      path.dirname(filePath),
      "sess-corrupt-meta",
      "subagents",
      `agent-${CHILD_HEX}.meta.json`
    ),
    "{ this is not json",
    "utf8"
  );

  const session = await parseSessionFile(filePath);
  const child = subagentOf(session, CHILD_HEX);
  assert.ok(session, "the session still parses");
  assert.equal(child?.type, "Explore", "falls back past the corrupt meta");
});

test("a CRLF-captured transcript resolves its kickoff identically (Windows)", async () => {
  // PR #3995's lesson, applied to this join. There, a Windows capture left a
  // trailing "\r" on every line; because "\r" is a LINE TERMINATOR to a JS
  // regex, a directive parser silently matched NOTHING and the adapter
  // returned zero targets while still CLAIMING the payload — silent, total
  // data loss that the corpus could not catch, because it contains no CRLF
  // capture. The same risk lives here: a "\r" surviving into a JSON string
  // value, or a reader that splits on "\n" alone, would corrupt the kickoff
  // rather than fail loudly.
  //
  // One payload, two encodings, so the two can never structurally drift. Both
  // the extracted field AND a downstream consequence are asserted — the second
  // is what catches "parsed nothing but silently defaulted".
  const lines = [
    userLine(),
    delegationLine({
      toolUseId: "toolu_crlf",
      type: "Explore",
      prompt: "Line one\nLine two",
      description: "CRLF capture",
    }),
  ];

  for (const [label, eol] of [
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ] as const) {
    const filePath = writeSession({
      sessionId: "sess-crlf",
      lines,
      eol,
      sidecars: [
        {
          hex: CHILD_HEX,
          lines: [childToolLine(CHILD_HEX, "toolu_child")],
          meta: {
            agentType: "Explore",
            description: "CRLF capture",
            toolUseId: "toolu_crlf",
          },
        },
      ],
    });

    const child = subagentOf(await parseSessionFile(filePath), CHILD_HEX);
    assert.equal(child?.type, "Explore", `${label}: type must resolve`);
    assert.equal(
      child?.task,
      "Line one\nLine two",
      `${label}: the kickoff prompt must round-trip byte-for-byte, with no stray CR`
    );
    assert.equal(
      child?.metadata?.spawnedByToolUseId,
      "toolu_crlf",
      `${label}: the delegation FK must resolve`
    );
    // Downstream consequence: an enriched record must reach the DB layer's
    // 500-char task prefix intact, which is what the live-hook reconciliation
    // and the agents row both read.
    assert.equal(
      (child?.task ?? "").slice(0, 500),
      "Line one\nLine two",
      `${label}: the stored task prefix must match`
    );
  }
});

test("a NESTED workflow agent joins on its provider id, not its path-qualified id", async () => {
  // A nested workflow agent's `subagent.id` is the collision-free relId
  // `workflows__<wf>__agent-<hex>`, while the result-side index is keyed on the
  // normalized bare `agent-<hex>`. Keying the lookup on `subagent.id` silently
  // missed every nested workflow agent, so one whose meta carries NO toolUseId
  // — the only case that depends on the result-side join — got no enrichment.
  const filePath = writeSession({
    sessionId: "sess-nested-wf",
    lines: [
      userLine(),
      delegationLine({
        toolUseId: "toolu_wf",
        type: "code-reviewer",
        prompt: "Review the nested change",
      }),
      resultLine({
        toolUseId: "toolu_wf",
        agentId: CHILD_HEX,
        agentType: "code-reviewer",
      }),
    ],
    sidecars: [
      {
        hex: CHILD_HEX,
        workflow: "wf-1",
        lines: [childToolLine(CHILD_HEX, "toolu_child")],
        // Deliberately no `toolUseId`: forces the result-side byAgentId join.
        meta: { description: "Nested review" },
      },
    ],
  });

  const session = await parseSessionFile(filePath);
  const child = session?.subagents?.find(
    (s) => s.id === `workflows__wf-1__agent-${CHILD_HEX}`
  );
  assert.ok(child, "the nested workflow agent is parsed under its relId");
  assert.equal(child?.type, "code-reviewer");
  assert.equal(child?.task, "Review the nested change");
  assert.equal(child?.metadata?.spawnedByToolUseId, "toolu_wf");
});
