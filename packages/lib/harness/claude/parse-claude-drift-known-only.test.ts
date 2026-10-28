/**
 * @file parse-claude-drift-known-only.test.ts
 * @description ISS-7258, extended by ISS-10593: the ten record types and
 * nineteen attributes triage settled as KNOWN-ONLY — seen in the live corpus,
 * consumed by nothing, and so owed a known-set entry and no other behavior at
 * all.
 *
 * Every case drives the REAL parser entry point over synthetic records rather
 * than reading the sets under test, so an entry dropped from a set fails here
 * instead of silently starting to cry wolf about a field the parser has always
 * seen. Each half is paired with its control — the same record carrying one
 * field the parser has never seen — because silence is also what a globally
 * disabled detector produces, and a suite that only asserts silence cannot tell
 * the two apart.
 *
 * The type and attribute names are SPELLED OUT rather than sourced from
 * `ClaudeRecordType`, for the reason the sibling
 * `parse-claude-drift-calibration.test.ts` spells its fixture out: these strings
 * are the HARNESS's spelling, not ours. Taking them from the constant under test
 * would move the input and the expectation together, so re-spelling one would
 * stay green while the parser stopped recognising what the harness sends.
 */
import { describe, expect, it } from "vitest";
import type { NormalizedSession } from "../types";
import { parseClaudeTranscript, scanTranscriptLines } from "./parse-claude";
import { createSessionAccumulator } from "./parse-claude-accumulator";
import { reportUnknownRecords } from "./parse-claude-drift";

const SESSION_ID = "sess-1";
const TS = "2026-07-09T12:00:01.000Z";
/** Never emitted by any harness, so it stays a genuine unknown as the sets grow. */
const UNSEEN_TYPE = "a-type-no-harness-emits";
const UNSEEN_ATTRIBUTE = "anAttributeNoHarnessEmits";

const BASELINE_USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "go" },
});
const BASELINE_ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-09T12:00:02.000Z",
  cwd: "/workspace/project",
  message: {
    id: "msg_1",
    role: "assistant",
    model: "claude-opus-4",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});
/** A transcript that parses to a session and reports no drift of its own. */
const BASELINE_LINES = [BASELINE_USER_LINE, BASELINE_ASSISTANT_LINE];

/**
 * One record per known-only type, carrying the payload the live corpus actually
 * puts on it. `timestamp` is inside the baseline's span wherever the real record
 * carries one, so the parity case below measures the record's contribution and
 * not a widened session window.
 */
const KNOWN_ONLY_RECORDS: [string, Record<string, unknown>][] = [
  ["relocated", { sessionId: SESSION_ID, relocatedCwd: "/workspace/moved" }],
  ["agent-setting", { sessionId: SESSION_ID, agentSetting: "default" }],
  ["agent-name", { sessionId: SESSION_ID, agentName: "general-purpose" }],
  ["custom-title", { sessionId: SESSION_ID, customTitle: "A title" }],
  [
    "file-history-delta",
    {
      timestamp: TS,
      messageId: "m-1",
      snapshotMessageId: "m-0",
      trackingPath: "/workspace/project/a.ts",
      backup: { path: "/backups/a.ts" },
    },
  ],
  ["atis-latch", { sessionId: SESSION_ID, atis: true }],
  [
    "bridge-session",
    {
      sessionId: SESSION_ID,
      bridgeSessionId: "bridge-1",
      lastSequenceNum: 3,
      // Third-party identity. Present in the fixture because the real record
      // carries it and the parser must go on reading nothing from it — never
      // because anything downstream may keep it.
      ownerAccountUuid: "00000000-0000-4000-8000-000000000001",
      ownerOrganizationUuid: "00000000-0000-4000-8000-000000000002",
    },
  ],
  [
    "frame-link",
    {
      sessionId: SESSION_ID,
      timestamp: TS,
      artifactCount: 2,
      frameUrl: "https://example.test/frame",
      path: "/workspace/project",
      title: "Frame",
    },
  ],
  ["artifact-comment-monitor", { sessionId: SESSION_ID, artifacts: [], v: 1 }],
  [
    "artifact-autoreact-ledger",
    {
      sessionId: SESSION_ID,
      v: 1,
      // Third-party identity, present for the same reason `bridge-session`
      // carries its two above: the parser must go on reading nothing from it.
      accountUuid: "00000000-0000-4000-8000-000000000003",
      artifacts: {
        "00000000-0000-4000-8000-000000000004": {
          savedAt: 1_789_579_124_513,
          stampHighWater: null,
          everBaselined: true,
          everHadThreads: false,
          turnTimestamps: [],
          threads: [],
        },
      },
    },
  ],
];

/** The smallest fully-known record of each type that carries a known-only attribute. */
const CARRIER_PAYLOADS: Record<string, Record<string, unknown>> = {
  user: { message: { role: "user", content: "hi" } },
  assistant: {
    message: { role: "assistant", model: "claude-opus-4", content: [] },
  },
  system: { subtype: "info", content: "text", level: "info" },
  "last-prompt": { lastPrompt: "do the thing", leafUuid: "leaf-1" },
  attachment: { attachment: { type: "hook_success" } },
  "queue-operation": { operation: "remove", content: "queued" },
};

/**
 * A known record type that carries NONE of the known-only attributes — the foil
 * the placement cases below hold each attribute against.
 */
const FOIL_TYPE = "mode";
const FOIL_PAYLOAD: Record<string, unknown> = { mode: "default" };

/**
 * Each known-only attribute against the type MEASURED to carry it across the
 * live corpus's top-level transcripts. The pairing is the assertion: an entry
 * moved to `COMMON_ATTRIBUTES` would silence the attribute everywhere and this
 * table would stop saying anything about where it actually rides.
 */
const KNOWN_ONLY_ATTRIBUTES: {
  type: string;
  attribute: string;
  value: unknown;
}[] = [
  { type: "user", attribute: "mcpMeta", value: { structuredContent: {} } },
  { type: "user", attribute: "classifierMetaLines", value: '{"meta":{}}\n' },
  { type: "user", attribute: "isVisibleInTranscriptOnly", value: true },
  { type: "user", attribute: "turnCompanion", value: true },
  { type: "user", attribute: "queuePriority", value: "later" },
  {
    type: "user",
    attribute: "queueOrigin",
    value: { kind: "task-notification", source: "artifact-watch-lifecycle" },
  },
  { type: "user", attribute: "userFeedback", value: "the user replied" },
  {
    type: "system",
    attribute: "logicalParentUuid",
    value: "f1bfb369-b56a-4d75-b276-baadf216294a",
  },
  { type: "system", attribute: "cronKind", value: "loop" },
  { type: "assistant", attribute: "isAbortedMidStream", value: true },
  { type: "last-prompt", attribute: "explicit", value: true },
  { type: "user", attribute: "queueSkipAttachments", value: true },
  { type: "assistant", attribute: "apiBlockIndex", value: 2 },
  { type: "assistant", attribute: "perTurnEffort", value: null },
  {
    type: "assistant",
    attribute: "wireToolInputs",
    value: {
      toolu_1: { command: "cd /workspace/project && ls", description: "list" },
    },
  },
  {
    type: "assistant",
    attribute: "wireIngestContext",
    value: { toolu_1: { cwd: "/workspace/project" } },
  },
  { type: "attachment", attribute: "rendered", value: [{ content: "text" }] },
  {
    type: "attachment",
    attribute: "renderedInHumanTurn",
    value: [{ content: "text" }],
  },
  {
    type: "queue-operation",
    attribute: "reason",
    value: "absorbed_mid_turn",
  },
];

async function reportFor(lines: string[]): Promise<string[]> {
  const messages: string[] = [];
  // Diagnostics are opt-in: a parse with nowhere to report retains nothing, so a
  // case that forgot this flag would assert silence against a collector that
  // never ran.
  const accumulator = createSessionAccumulator({ collectDiagnostics: true });
  await scanTranscriptLines(lines, accumulator);
  reportUnknownRecords(accumulator, (message) => messages.push(message));
  return messages;
}

describe("a known-only record type is decoded-as-ignored, not reported as drift", () => {
  for (const [type, payload] of KNOWN_ONLY_RECORDS) {
    it(`reports nothing for a \`${type}\` record`, async () => {
      const messages = await reportFor([
        ...BASELINE_LINES,
        JSON.stringify({ type, ...payload }),
      ]);
      // Silent on BOTH reports, and the second half is the point: a no-op case
      // runs no attribute-level detection, so the record's own fields are never
      // named either. That is the contract the no-op buys.
      expect(messages).toEqual([]);
    });
  }

  it("still reports a record type nothing has ever seen", async () => {
    const messages = await reportFor([
      ...BASELINE_LINES,
      JSON.stringify({ type: UNSEEN_TYPE, timestamp: TS }),
    ]);
    expect(messages).toEqual([`Unknown record types: "${UNSEEN_TYPE}" (1)`]);
  });
});

describe("a known-only attribute is silent on the type measured to carry it", () => {
  for (const { type, attribute, value } of KNOWN_ONLY_ATTRIBUTES) {
    it(`reports nothing for \`${attribute}\` on a \`${type}\` record`, async () => {
      const messages = await reportFor([
        ...BASELINE_LINES,
        JSON.stringify({
          type,
          timestamp: TS,
          ...CARRIER_PAYLOADS[type],
          [attribute]: value,
        }),
      ]);
      expect(messages).toEqual([]);
    });

    it(`still reports an unseen attribute beside \`${attribute}\` on a \`${type}\` record`, async () => {
      // The control that makes the silence above mean something: the detector is
      // demonstrably live for this type, so the quiet came from the set entry
      // and not from a set widened to everything or a handler that collects
      // nothing.
      const messages = await reportFor([
        ...BASELINE_LINES,
        JSON.stringify({
          type,
          timestamp: TS,
          ...CARRIER_PAYLOADS[type],
          [attribute]: value,
          [UNSEEN_ATTRIBUTE]: 1,
        }),
      ]);
      expect(messages).toEqual([
        `Unknown attributes for record type "${type}": "${UNSEEN_ATTRIBUTE}"`,
      ]);
    });

    it(`still reports \`${attribute}\` on a \`${FOIL_TYPE}\` record, which does not carry it`, async () => {
      // The second control, and the one that pins the PLACEMENT rather than the
      // membership: an entry parked in `COMMON_ATTRIBUTES` — or copied into
      // every per-type set — silences the attribute on every record kind, and
      // both of those pass the case above. Only a foil type the measurement
      // says does not carry the attribute can tell the two apart.
      const messages = await reportFor([
        ...BASELINE_LINES,
        JSON.stringify({
          type: FOIL_TYPE,
          timestamp: TS,
          ...FOIL_PAYLOAD,
          [attribute]: value,
        }),
      ]);
      expect(messages).toEqual([
        `Unknown attributes for record type "${FOIL_TYPE}": "${attribute}"`,
      ]);
    });
  }
});

describe("a known-only record contributes nothing to the parsed session", () => {
  it("parses to the same session with every known-only record interleaved", async () => {
    const withKnownOnly = [
      BASELINE_USER_LINE,
      ...KNOWN_ONLY_RECORDS.map(([type, payload]) =>
        JSON.stringify({ type, ...payload })
      ),
      BASELINE_ASSISTANT_LINE,
    ];
    const baseline = await parseClaudeTranscript(BASELINE_LINES, {
      sessionId: SESSION_ID,
    });
    const augmented = await parseClaudeTranscript(withKnownOnly, {
      sessionId: SESSION_ID,
    });
    if (baseline === null || augmented === null) {
      throw new Error("both fixtures must parse to a session");
    }

    // `parseQuality` counts lines ATTEMPTED, so it is the one field that has to
    // move — one more line per known-only record, and nothing malformed.
    // Everything else is the session itself, and none of it may change.
    const { parseQuality: baselineQuality, ...baselineSession } = baseline;
    const { parseQuality: augmentedQuality, ...augmentedSession } = augmented;
    expect(augmentedSession).toEqual(baselineSession);
    expect(augmentedQuality).toEqual({
      ...baselineQuality,
      totalLines:
        (baselineQuality?.totalLines ?? 0) + KNOWN_ONLY_RECORDS.length,
    });
  });
});

/**
 * ISS-10593: the harness owns this format and keeps adding to it, so the sets
 * above are a snapshot that is wrong again the next time Claude Code ships. What
 * has to hold across that is not the sets but the FALLBACK: an attribute or a
 * whole record type nobody here has ever seen costs the report a line and costs
 * the session nothing.
 */
describe("an unrecognised field degrades to a report, never to lost data", () => {
  it("names an attribute nothing has seen and keeps every field of its record", async () => {
    const messages: string[] = [];
    const baseline = await parseWithLogger(BASELINE_LINES, []);
    const augmented = await parseWithLogger(
      [
        BASELINE_USER_LINE,
        JSON.stringify({
          ...(JSON.parse(BASELINE_ASSISTANT_LINE) as Record<string, unknown>),
          [UNSEEN_ATTRIBUTE]: { nested: ["whatever the harness adds next"] },
        }),
      ],
      messages
    );
    expect(messages).toEqual([
      `Unknown attributes for record type "assistant": "${UNSEEN_ATTRIBUTE}"`,
    ]);
    // Line-for-line the same transcript, so not even `parseQuality` may move:
    // the unknown attribute rides a record the parser already decodes, and the
    // model, tokens and events it contributes are exactly what must survive.
    expect(augmented).toEqual(baseline);
  });

  it("names a record type nothing has seen and keeps the surrounding session", async () => {
    const messages: string[] = [];
    const baseline = await parseWithLogger(BASELINE_LINES, []);
    const augmented = await parseWithLogger(
      [
        BASELINE_USER_LINE,
        JSON.stringify({ type: UNSEEN_TYPE, timestamp: TS, payload: { a: 1 } }),
        BASELINE_ASSISTANT_LINE,
      ],
      messages
    );
    expect(messages).toEqual([`Unknown record types: "${UNSEEN_TYPE}" (1)`]);
    const { parseQuality: baselineQuality, ...baselineSession } = baseline;
    const { parseQuality: augmentedQuality, ...augmentedSession } = augmented;
    expect(augmentedSession).toEqual(baselineSession);
    // Read and counted, NOT malformed — an undecoded type is a line the parser
    // attempted, so it must not land in whatever `parseQuality` calls a failure.
    expect(augmentedQuality).toEqual({
      ...baselineQuality,
      totalLines: (baselineQuality?.totalLines ?? 0) + 1,
    });
  });
});

/**
 * A parse with the logger the DESKTOP collector supplies, which is what turns
 * diagnostics on. Both halves of each case above run through it: a baseline
 * parsed with diagnostics off would differ from its comparand in configuration
 * as well as content, and — the reason it is worth a helper — the collector
 * would never run, so a parser that made an unknown field fatal would leave
 * these cases green.
 */
async function parseWithLogger(
  lines: string[],
  messages: string[]
): Promise<NormalizedSession> {
  const session = await parseClaudeTranscript(lines, {
    sessionId: SESSION_ID,
    logger: (message) => messages.push(message),
  });
  if (session === null) {
    throw new Error("fixture must parse to a session");
  }
  return session;
}
