/**
 * @file parse-claude-drift-calibration.test.ts
 * @description The drift detector's attribute sets are a CALIBRATION TABLE, and
 * this is the test that pins it.
 *
 * The sets record every attribute the harness is known to emit, so that against
 * a current transcript the report is SILENT and the first thing it ever says is
 * that the harness started sending something new. Both halves of that contract
 * run over the SAME per-type fixture table below:
 *
 *   - every KNOWN attribute must NOT be reported — the fixture as written;
 *   - a NEW attribute must be reported — the fixture plus one novel field.
 *
 * The first half is what decays. Drop an entry from a set and the detector
 * starts crying wolf about a field the parser has always seen; the sets are
 * data, so nothing else fails. The second half is what a deleted handler body
 * gets away with, since a handler that collects nothing is also silent.
 *
 * The attribute lists here are deliberately SPELLED OUT rather than derived from
 * the exported sets. Building the fixture from the same constant under test
 * would be circular — mutating the set would change the input and the
 * expectation together, and the test could never fail.
 */
import { describe, expect, it } from "vitest";
import { createSessionAccumulator } from "./parse-claude-accumulator";
import { scanTranscriptLines } from "./parse-claude-core";
import { reportUnknownRecords } from "./parse-claude-drift";

const TS = "2026-07-09T12:00:01.000Z";

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "go" },
});

/** Envelope attributes legal on ANY record, whatever its type. */
const COMMON: Record<string, unknown> = {
  timestamp: TS,
  cwd: "/workspace/project",
  version: "1.4.2",
  slug: "a-slug",
  gitBranch: "feat/x",
  entrypoint: "claude",
  permissionMode: "acceptEdits",
  teamName: "platform-engineering",
  sessionId: "sess-1",
  session_id: "sess-1",
  uuid: "u-1",
  parentUuid: null,
  userType: "external",
  isSidechain: false,
  isCompactSummary: false,
  isApiErrorMessage: false,
};

/**
 * One record per type, carrying that type's documented payload attributes.
 * Spelled out on purpose — see the file docstring.
 */
const RECORDS: [string, Record<string, unknown>][] = [
  [
    "user",
    {
      message: { role: "user", content: "hi" },
      imagePasteIds: [],
      interruptedMessageId: null,
      isMeta: false,
      origin: { kind: "human" },
      promptId: "p-1",
      promptSource: "cli",
      sourceToolAssistantUUID: null,
      sourceToolUseID: null,
      toolDenialKind: null,
      toolUseResult: null,
    },
  ],
  [
    "assistant",
    {
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: "ok" }],
      },
      requestId: "req-1",
      apiErrorStatus: null,
      error: null,
      isApiErrorMessage: false,
      // The fixture omitted these two, so the calibration case asserted silence
      // against a record shape the corpus does not actually contain — and the
      // detector cried wolf on every real sidechain record the moment it was
      // given a logger. A fixture that under-describes the record is the exact
      // way this table decays.
      agentId: "ad00546980b4b4701",
      attributionAgent: "general-purpose",
      attributionMcpServer: null,
      attributionMcpTool: null,
      attributionPlugin: null,
      attributionSkill: null,
    },
  ],
  ["attachment", { attachment: { type: "hook_success" } }],
  ["ai-title", { aiTitle: "A title" }],
  ["last-prompt", { lastPrompt: "do the thing", leafUuid: "leaf-1" }],
  ["mode", { mode: "default" }],
  ["permission-mode", {}],
  [
    "pr-link",
    { prNumber: 1, prRepository: "owner/repo", prUrl: "https://example/pr/1" },
  ],
  [
    "file-history-snapshot",
    { isSnapshotUpdate: false, messageId: "m-1", snapshot: {} },
  ],
  [
    "system",
    {
      subtype: "turn_duration",
      content: "text",
      level: "info",
      durationMs: 10,
      isMeta: false,
      toolUseID: "toolu_1",
      stopReason: null,
      hasOutput: false,
      messageCount: 1,
      preventedContinuation: false,
      hookAdditionalContext: null,
      hookCount: 0,
      hookErrors: [],
      hookInfos: [],
    },
  ],
  ["queue-operation", { operation: "enqueue", content: "queued" }],
];

async function reportFor(record: Record<string, unknown>): Promise<string[]> {
  const messages: string[] = [];
  // Diagnostics are opt-in: a parse with nowhere to report retains nothing, so a
  // suite that forgot this flag would assert silence against a collector that was
  // never running. Every case here needs it ON for its assertion to mean anything.
  const accumulator = createSessionAccumulator({ collectDiagnostics: true });
  await scanTranscriptLines([USER_LINE, JSON.stringify(record)], accumulator);
  reportUnknownRecords(accumulator, (message) => messages.push(message));
  return messages;
}

describe("the drift detector stays silent on the schema it knows", () => {
  for (const [type, payload] of RECORDS) {
    it(`reports nothing for a fully-populated \`${type}\` record`, async () => {
      const messages = await reportFor({ type, ...COMMON, ...payload });
      expect(messages).toEqual([]);
    });
  }
});

describe("the drift detector speaks up for every record type it decodes", () => {
  // The control that makes the silence above meaningful, run per type rather
  // than once: silence is also what a handler that collects NOTHING produces,
  // so a type whose decode is drift collection ALONE — `last-prompt`, `mode`,
  // `permission-mode`, `file-history-snapshot`, `queue-operation` — passes the
  // calibration cases with its body deleted. Each record here is its
  // fully-populated fixture plus one field the parser has never seen, and the
  // detector has to name it against that type. This is the half of ISS-6048
  // that reports the harness sending something new.
  for (const [type, payload] of RECORDS) {
    it(`reports a novel attribute on a \`${type}\` record`, async () => {
      const messages = await reportFor({
        type,
        ...COMMON,
        ...payload,
        unexpectedNewField: 1,
      });
      expect(messages).toEqual([
        `Unknown attributes for record type ${type}: unexpectedNewField`,
      ]);
    });
  }
});
