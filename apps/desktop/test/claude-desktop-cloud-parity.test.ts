/**
 * @file claude-desktop-cloud-parity.test.ts
 * @description The property the parser deduplication exists to guarantee: the
 * desktop importer and the cloud session-detail renderer interpret one
 * transcript identically.
 *
 * They reach the same core by DIFFERENT routes, and that is the whole risk. The
 * cloud calls the one-shot `parseClaudeTranscript`; the desktop shell drives the
 * pieces by hand — `scanTranscriptLines`, then the delegated-agent file merge,
 * then `buildSession`, then `enrichSidecarSubagents` — because its merge lands in
 * the middle and needs local disk. Nothing else in the suite compares the two
 * compositions, so a derivation added to one and not the other is invisible:
 * the golden corpus only exercises the desktop route, and the cloud's own tests
 * assert little beyond message roles.
 *
 * The fixture deliberately has NO `subagents/` directory, which makes the
 * desktop-only merge a no-op and leaves the two routes comparable. `parseQuality`
 * and `fileModifiedAt` are the sanctioned differences: the cloud never reads a
 * file, so it has no mtime, and it is handed lines rather than counting them off
 * disk.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { parseClaudeTranscript } from "@repo/lib/harness/claude/parse-claude-core";
import type { NormalizedSession } from "@repo/lib/harness/types";
import { parseSessionFile } from "../src/main/collectors/claude/claude-parser.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

/**
 * A transcript exercising every lane the two routes share: session attributes, a
 * human turn, a slash command in USER text and another in ASSISTANT text, a tool
 * call, a Skill invocation on an inline sidechain, token usage across two turns,
 * usage extras, an inline plan, an API error, and a compaction marker.
 */
const TRANSCRIPT_LINES: string[] = [
  JSON.stringify({
    type: "user",
    uuid: "u-1",
    timestamp: "2026-07-09T12:00:00.000Z",
    cwd: "/workspace/project",
    version: "1.4.2",
    slug: "parity-branch",
    gitBranch: "feat/parity",
    permissionMode: "acceptEdits",
    teamName: "platform-engineering",
    message: {
      role: "user",
      content: "<command-name>/design-review</command-name> please review",
    },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a-1",
    timestamp: "2026-07-09T12:00:01.000Z",
    requestId: "req-1",
    message: {
      role: "assistant",
      id: "msg-1",
      model: "claude-opus-4",
      content: [
        { type: "text", text: "Working on it." },
        {
          type: "tool_use",
          id: "toolu_read_1",
          name: "Read",
          input: { file_path: "/workspace/project/src/index.ts" },
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 45,
        cache_read_input_tokens: 10,
        service_tier: "standard",
        inference_geo: "us-east-1",
      },
    },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a-2",
    timestamp: "2026-07-09T12:00:02.000Z",
    agentId: "ad00546980b4b4701",
    isSidechain: true,
    attributionAgent: "code-reviewer",
    message: {
      role: "assistant",
      id: "msg-2",
      model: "claude-opus-4",
      content: [
        {
          type: "tool_use",
          id: "toolu_skill_1",
          name: "Skill",
          input: { skill: "code-review" },
        },
      ],
      usage: { input_tokens: 30, output_tokens: 12 },
    },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a-3",
    timestamp: "2026-07-09T12:00:03.000Z",
    message: {
      role: "assistant",
      id: "msg-3",
      model: "claude-opus-4",
      content: [
        {
          type: "text",
          text: "<command-name>/visual-qa</command-name> queued next.",
        },
      ],
      usage: { input_tokens: 15, output_tokens: 8 },
    },
  }),
  JSON.stringify({
    type: "user",
    uuid: "u-2",
    isCompactSummary: true,
    timestamp: "2026-07-09T12:00:04.000Z",
    message: { role: "user", content: "summary" },
  }),
  JSON.stringify({
    type: "ai-title",
    uuid: "t-1",
    timestamp: "2026-07-09T12:00:05.000Z",
    aiTitle: "Parity check",
  }),
];

/** Fields the two routes are ALLOWED to differ on, and why. */
const ROUTE_SPECIFIC_KEYS = [
  // The cloud never touches a file, so it has no mtime to stamp.
  "fileModifiedAt",
  // The desktop counts lines off disk and folds each agent file's quality in;
  // the cloud is handed an array it did not read.
  "parseQuality",
] as const;

function comparable(session: NormalizedSession): Record<string, unknown> {
  const copy = { ...session } as Record<string, unknown>;
  for (const key of ROUTE_SPECIFIC_KEYS) {
    delete copy[key];
  }
  return copy;
}

describe("desktop and cloud interpret one transcript identically", () => {
  test("every derived field agrees across the two compositions", async () => {
    const dir = makeTempDir("claude-parity-");
    const sessionId = "019f3357-0011-7000-8000-0000000000aa";
    const file = path.join(dir, `${sessionId}.jsonl`);
    writeFileSync(file, `${TRANSCRIPT_LINES.join("\n")}\n`);

    const desktop = await parseSessionFile(file);
    const cloud = await parseClaudeTranscript(TRANSCRIPT_LINES, { sessionId });

    assert.ok(desktop, "desktop route produced no session");
    assert.ok(cloud, "cloud route produced no session");
    assert.deepEqual(comparable(desktop), comparable(cloud));
  });

  test("the fixture actually exercises the lanes it claims to", async () => {
    // Guards the test above from decaying into a comparison of two empty
    // sessions: a fixture that stopped parsing would still deep-equal itself.
    const sessionId = "019f3357-0011-7000-8000-0000000000ab";
    const cloud = await parseClaudeTranscript(TRANSCRIPT_LINES, { sessionId });
    assert.ok(cloud);

    assert.deepEqual(
      cloud.slashCommands.map((command) => command.name),
      ["/design-review", "/visual-qa"],
      "both slash-command lanes must be represented"
    );
    assert.deepEqual(
      cloud.skills.map((skill) => skill.name),
      ["code-review"],
      "the inline-sidechain Skill must appear exactly once"
    );
    assert.equal(cloud.subagents?.length, 1);
    assert.equal(cloud.userMessages, 1);
    assert.equal(cloud.assistantMessages, 3);
    assert.deepEqual(cloud.teams, ["platform-engineering"]);
    assert.deepEqual(cloud.usageExtras.service_tiers, ["standard"]);
    assert.deepEqual(cloud.usageExtras.inference_geos, ["us-east-1"]);
    assert.equal(cloud.compactions.length, 1);
    assert.equal(cloud.name, "Parity check");
    assert.ok(
      Object.keys(cloud.tokensByModel).length > 0,
      "token totals must be populated"
    );
  });

  test("the comparison would notice a divergence", async () => {
    // The parity assertion is only worth its runtime if an actual difference
    // fails it. Prove the deep-equal is load-bearing rather than trivially true.
    const dir = makeTempDir("claude-parity-neg-");
    const sessionId = "019f3357-0011-7000-8000-0000000000ac";
    const file = path.join(dir, `${sessionId}.jsonl`);
    writeFileSync(file, `${TRANSCRIPT_LINES.join("\n")}\n`);

    const desktop = await parseSessionFile(file);
    const cloud = await parseClaudeTranscript(TRANSCRIPT_LINES, { sessionId });
    assert.ok(desktop && cloud);

    const divergent = { ...comparable(cloud), skills: [] };
    assert.notDeepEqual(comparable(desktop), divergent);
  });
});
