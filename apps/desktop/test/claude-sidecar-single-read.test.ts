/**
 * @file claude-sidecar-single-read.test.ts
 * @description ISS-5542 — a Claude `subagents/agent-*.jsonl` sidecar is opened
 * and JSON-parsed EXACTLY ONCE per session import.
 *
 * The parser used to stream every sidecar twice, back to back in one loop
 * iteration: `collectEntriesFromFile` for tokens, parse-quality, delegations and
 * the ISS-5402 diff stats, then `scanSubagentTranscriptStream` re-opening the
 * same path for its `tool_use` blocks. ISS-5402's own PR measured 302 sidecars
 * on one real session — ~604 whole-file reads per import, re-paid by the boot
 * import and by every `DATA_REVISION` rebuild.
 *
 * The READ COUNT is the assertion, not the parsed output. Both passes fed the
 * same extractor over the same lines, so the merged records are byte-identical
 * before and after the fold and an output-parity test passes against the old
 * two-pass code. Output parity is still asserted here — as the positive control
 * that the surviving pass actually produced the records, so a fold that
 * collapsed the read by dropping the work could not read as a pass.
 *
 * The second case pins the boundary the fold had to carry across rather than
 * quietly widen: the scanner bailed the WHOLE file to `{toolUses: []}` on the
 * first malformed line, where the entries pass around it skips-and-counts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";
import {
  assistantLine,
  DELEGATING_ONLY_PARENT,
  editBlock,
  INPUT_TOKENS_PER_TURN,
  MODEL,
  skillBlock,
} from "./sidecar-diff-stats-fixtures.js";

/** The sidecar `writeClaudeTranscript` writes for `subagents: { <name>: … }`. */
function sidecarPath(parentFile: string, sessionId: string, name: string) {
  return path.join(
    path.dirname(parentFile),
    sessionId,
    "subagents",
    `agent-${name}.jsonl`
  );
}

/**
 * Run `parseClaudeFile` and report how many times `target` was opened for read.
 *
 * `createReadStream` cannot be intercepted directly: every reader of a sidecar
 * imports it as a NAMED binding from `node:fs`, and a builtin's named ESM export
 * is snapshotted at instantiation, so a later reassignment is invisible to it.
 * `fs.open` is the property lookup Node's own read stream performs on the shared
 * module object, so one open of `target` is one stream over it.
 *
 * That indirection fails CLOSED. If a future Node stopped routing
 * `createReadStream` through the public `fs.open`, the count would read 0 and
 * the assertion below would fail loudly rather than pass on a stale mechanism.
 */
async function parseCountingOpensOf(parentFile: string, target: string) {
  const originalOpen = fs.open;
  let opens = 0;
  const counting = Object.assign(
    (...args: unknown[]) => {
      if (args[0] === target) {
        opens++;
      }
      return Reflect.apply(originalOpen, fs, args);
    },
    { __promisify__: originalOpen.__promisify__ }
  );
  fs.open = counting;
  try {
    return { parsed: await parseClaudeFile(parentFile), opens };
  } finally {
    fs.open = originalOpen;
  }
}

test("ISS-5542: a sidecar transcript is opened once per import, not twice", async () => {
  const sessionId = "sess-single-read";
  const filePath = writeClaudeTranscript(sessionId, DELEGATING_ONLY_PARENT, {
    subagents: {
      lane: [
        assistantLine("sub-u1", "req_sub", "msg_sub", [
          editBlock("toolu_single_read", "/repo/src/lane.ts"),
          skillBlock("toolu_single_read_skill", "lane-skill"),
        ]),
      ],
    },
  });
  const subFile = sidecarPath(filePath, sessionId, "lane");

  const { parsed, opens } = await parseCountingOpensOf(filePath, subFile);

  assert.equal(
    opens,
    1,
    "the sidecar must be streamed once — the tool-use extraction now folds into the pass that already reads every line"
  );

  // Positive control: the surviving pass still yields what the deleted one did.
  assert.ok(parsed);
  const subagent = (parsed.subagents ?? []).find((s) => s.id === "agent-lane");
  assert.ok(subagent, "the sidecar must produce a sub-agent row");
  assert.deepEqual(
    (subagent.toolUses ?? []).map((toolUse) => toolUse.name),
    ["Edit", "Skill"],
    "both sidecar tool uses must survive the collapsed pass"
  );
  assert.deepEqual(
    parsed.skills.map((skill) => skill.name),
    ["lane-skill"],
    "the merged records must still reach the session skills projection"
  );
});

test("ISS-5542: a malformed sidecar line still drops that file's tool uses whole", async () => {
  // The old scanner returned `{toolUses: []}` from the first malformed line —
  // strictly narrower than the skip-and-count the entries pass applies, because
  // a truncated line can split a `tool_use` block and half a block is not a tool
  // use. The fold reproduces that posture; it must not inherit skip-and-count.
  const sessionId = "sess-malformed-sidecar";
  const filePath = writeClaudeTranscript(sessionId, DELEGATING_ONLY_PARENT, {
    subagents: {
      lane: [
        assistantLine("sub-u1", "req_sub_a", "msg_sub_a", [
          editBlock("toolu_before_corruption", "/repo/src/before.ts"),
        ]),
        assistantLine("sub-u2", "req_sub_b", "msg_sub_b", [
          editBlock("toolu_after_corruption", "/repo/src/after.ts"),
        ]),
      ],
    },
  });
  const subFile = sidecarPath(filePath, sessionId, "lane");
  const [firstLine, secondLine] = fs
    .readFileSync(subFile, "utf8")
    .trimEnd()
    .split("\n");
  // Corruption MID-file, not trailing: a malformed final line is the benign
  // shape of a live write and is discounted from the parent's quality counts.
  fs.writeFileSync(
    subFile,
    `${firstLine}\n{"type":"assistant","message":{"content":[{"type":"too\n${secondLine}\n`,
    "utf8"
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  const subagent = (parsed.subagents ?? []).find((s) => s.id === "agent-lane");
  assert.ok(subagent, "the sidecar must still produce a sub-agent row");
  assert.deepEqual(
    (subagent.toolUses ?? []).map((toolUse) => toolUse.name),
    [],
    "one malformed line drops the whole file's tool uses, as the scanner did"
  );

  // …and the bail stays scoped to the tool-use projection. Everything else the
  // single pass derives is unchanged: the malformed line is counted, not
  // swallowed, and the two well-formed turns are still billed.
  assert.equal(parsed.parseQuality?.malformedLines, 1);
  assert.equal(
    parsed.tokensByModel[MODEL]?.input,
    INPUT_TOKENS_PER_TURN * 3,
    "the parent turn plus both readable sidecar turns must still be folded"
  );
});
