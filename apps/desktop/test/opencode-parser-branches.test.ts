/**
 * @file opencode-parser-branches.test.ts
 * @description ISS-11281: pins the message-row and part-row fallbacks of the
 * OpenCode parser that the store-shaped suites never reach — model-id aliases,
 * role/text/cwd fallbacks, the tool error path, patch/step-finish variants, and
 * the session-row columns a version-skewed store can hand back as non-strings.
 *
 * The session row is a real `opencode.db` row (shared fixture); the message and
 * part rows go through the loader's own `wrapRowReaders` seam, so each case can
 * hand the parser exactly the row shape it needs without a second copy of the
 * schema DDL.
 *
 * Every injected row is one `node:sqlite` can return: `data` is a JSON string,
 * and an unreadable timestamp is {@link UNPARSEABLE_TIMESTAMP}. The one
 * exception is a null `time_created` next to a set `time_updated` (the
 * message and part timestamp cases). The fixture's DDL, today's OpenCode
 * schema, declares that column `NOT NULL`, so this null only comes from a store
 * whose schema drops the constraint. Those two cases pin the parser's `??`
 * fallback to `time_updated` for that version-skewed store.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ToolResultState } from "@repo/api/src/types/operation-claims";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { OpencodeDefaultModel } from "@repo/lib/harness/synthetic-model-keys";
import { afterEach, describe, it } from "vitest";
import { loadOpencodeSessionsFromDb } from "../src/main/collectors/opencode/opencode-parser.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { resolveImportedSessionStatus } from "../src/main/database/imported-session-status.js";
import { PARSE_POLICY_BASE } from "../src/main/parse-policy/parse-policy.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";
import {
  SESSION_MODEL_ID,
  SESSION_PERMISSION,
  SESSION_VERSION,
  sessionSlug,
  TIME_CREATED,
  TIME_UPDATED,
  UNPARSEABLE_TIMESTAMP,
  writeOpencodeDb,
} from "./opencode-store-fixture.js";
import { withParsePolicy } from "./support/attribution-parse-policy.js";

afterEach(cleanupTempDirs);

type Row = Record<string, unknown>;

const SESSION_ID = "ses_branch";
const SESSION_START_ISO = new Date(TIME_CREATED).toISOString();
const T1 = TIME_CREATED + 10_000;
const T2 = TIME_CREATED + 20_000;
const T3 = TIME_CREATED + 30_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const UNUSABLE_EPOCH_RE = /is not a usable epoch; fileModifiedAt is null/;

const USER_ROW: Row = {
  id: "m-user",
  time_created: T1,
  time_updated: T1,
  data: JSON.stringify({ role: "user", time: { created: T1 } }),
};

type LoadResult = {
  session: NormalizedSession;
  logs: string[];
};

/**
 * Load the one fixture session with the given message/part rows. `sessionSql`
 * runs against the store first, to give the session row a shape the fixture
 * writer does not produce.
 */
function load(
  messages: Row[],
  parts: Row[] = [],
  sessionSql?: string
): LoadResult {
  const dbPath = writeOpencodeDb(makeTempDir("opencode-parser-branches-"), [
    { id: SESSION_ID, withoutMessages: true },
  ]);
  if (sessionSql) {
    const db = new DatabaseSync(dbPath);
    db.exec(sessionSql);
    db.close();
  }
  const logs: string[] = [];
  const result = loadOpencodeSessionsFromDb(dbPath, {
    log: (message) => logs.push(message),
    wrapRowReaders: () => ({
      readMessages: () => messages,
      readParts: () => parts,
    }),
  });
  // Throws rather than asserting so the fixture builder stays assertion-free.
  if (result.droppedSessions.length !== 0 || result.sessions.length !== 1) {
    throw new Error(
      `expected exactly one parsed session and no drops, got ${result.sessions.length} parsed / ${result.droppedSessions.length} dropped`
    );
  }
  return { session: result.sessions[0], logs };
}

function messageRow(id: string | undefined, ms: number, data: unknown): Row {
  return {
    ...(id === undefined ? {} : { id }),
    time_created: ms,
    time_updated: ms,
    data: typeof data === "string" ? data : JSON.stringify(data),
  };
}

function partRow(
  id: string,
  ms: number | null,
  data: unknown,
  messageId: string | null = "m-user"
): Row {
  return {
    id,
    message_id: messageId,
    time_created: ms,
    time_updated: ms,
    data: typeof data === "string" ? data : JSON.stringify(data),
  };
}

describe("OpenCode message rows", () => {
  it("resolves the per-message model through modelID, id, name, the tokens payload, and the session model", () => {
    const { session } = load([
      messageRow("m1", T1, { role: "user", model: { name: "named-model" } }),
      messageRow("m2", T2, { role: "assistant", model: {} }),
      messageRow("m3", T3, { role: "assistant", model: "" }),
      messageRow("m4", T3 + 1, {
        role: "assistant",
        tokens: JSON.stringify({ input: 5, output: 7, modelID: "tok-model" }),
      }),
      messageRow("m5", T3 + 2, { role: "user", modelID: OpencodeDefaultModel }),
    ]);
    assert.deepEqual(
      session.messages.map((m) => [m.role, m.model, m.isSynthetic ?? false]),
      [
        ["human", "named-model", false],
        ["assistant", SESSION_MODEL_ID, false],
        ["assistant", SESSION_MODEL_ID, false],
        ["assistant", "tok-model", false],
        ["human", OpencodeDefaultModel, true],
      ]
    );
    assert.deepEqual(session.tokenSeries, [
      {
        timestamp: iso(T3 + 1),
        model: "tok-model",
        input: 5,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ]);
    assert.deepEqual(session.messages[3].tokens, {
      input: 5,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("marks a synthetic per-message model on assistant turns too", () => {
    const { session } = load([
      USER_ROW,
      messageRow("m2", T2, { role: "ai", modelID: OpencodeDefaultModel }),
    ]);
    assert.equal(session.messages[1].role, "assistant");
    assert.equal(session.messages[1].isSynthetic, true);
    assert.equal(session.assistantMessages, 1);
  });

  it("falls back from role to type, skips unknown and non-object rows, and still records a row's error", () => {
    const { session } = load([
      USER_ROW,
      messageRow("m-type", T2, { type: "model", content: "via type" }),
      messageRow("m-unknown", T3, {
        role: "constructor",
        error: { message: "quota exceeded" },
      }),
      messageRow("m-roleless", T3 + 1, { error: "roleless failure" }),
      messageRow("m-scalar", T3 + 2, "42"),
    ]);
    assert.equal(session.userMessages, 1);
    assert.equal(session.assistantMessages, 1);
    assert.deepEqual(
      session.messages.map((m) => m.text),
      [null, "via type"]
    );
    assert.deepEqual(session.apiErrors, [
      { type: "error", message: "quota exceeded", timestamp: iso(T3) },
      { type: "error", message: "roleless failure", timestamp: iso(T3 + 1) },
    ]);
  });

  it("records OpenCode's { name, data } error on a zero-token turn, so the run ends on an error", () => {
    const { session } = load([
      USER_ROW,
      messageRow("m-failed", T2, {
        role: "assistant",
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        error: {
          name: "APIError",
          data: {
            message:
              "Error from provider (Console): Rate limit exceeded. Please try again later.",
            statusCode: 429,
            isRetryable: true,
          },
        },
      }),
    ]);
    assert.deepEqual(session.apiErrors, [
      {
        type: "error",
        message:
          "Error from provider (Console): Rate limit exceeded. Please try again later.",
        timestamp: iso(T2),
      },
    ]);
    assert.equal(
      resolveImportedSessionStatus(session, false),
      SESSION_STATUS.ERROR
    );
  });

  it("names a message-less OpenCode error by its name, and skips a user abort", () => {
    const { session } = load([
      USER_ROW,
      messageRow("m-length", T2, {
        role: "assistant",
        error: { name: "MessageOutputLengthError", data: {} },
      }),
      messageRow("m-abort", T3, {
        role: "assistant",
        error: {
          name: "MessageAbortedError",
          data: { message: "The operation was aborted." },
        },
      }),
    ]);
    assert.deepEqual(session.apiErrors, [
      {
        type: "error",
        message: "MessageOutputLengthError",
        timestamp: iso(T2),
      },
    ]);
  });

  it("reads a message timestamp from data.time, then the row's time_created, then time_updated", () => {
    const { session } = load([
      {
        id: "m1",
        time_created: T1,
        time_updated: T2,
        data: JSON.stringify({ role: "user" }),
      },
      {
        id: "m2",
        time_created: null,
        time_updated: T3,
        data: JSON.stringify({ role: "assistant", time: "not-an-object" }),
      },
    ]);
    assert.deepEqual(
      session.messages.map((m) => m.timestamp),
      [iso(T1), iso(T3)]
    );
    assert.deepEqual(session.messageTimestamps, [iso(T3)]);
  });

  it("still pushes tokens for a message row with no id", () => {
    const { session } = load(
      [
        messageRow(undefined, T1, {
          role: "user",
          tokens: { input: 3, output: 4 },
        }),
      ],
      [
        partRow(
          "p1",
          T2,
          { type: "step-finish", tokens: { input: 1, output: 2 } },
          null
        ),
      ]
    );
    assert.deepEqual(
      session.tokenSeries.map((t) => [t.timestamp, t.input, t.output]),
      [
        [iso(T1), 3, 4],
        [iso(T2), 1, 2],
      ]
    );
  });

  it("joins array content from strings and text parts, reads data.text, and yields null when neither exists", () => {
    const { session } = load([
      messageRow("m1", T1, {
        role: "user",
        content: [
          "plain",
          { type: "text", text: "typed" },
          { type: "image", text: "ignored" },
          { type: "text", text: 5 },
          7,
        ],
      }),
      messageRow("m2", T2, { role: "assistant", content: [{ type: "tool" }] }),
      messageRow("m3", T3, { role: "assistant", text: "from text" }),
      messageRow("m4", T3 + 1, { role: "assistant", content: 9 }),
    ]);
    assert.deepEqual(
      session.messages.map((m) => m.text),
      ["plain\ntyped", null, "from text", null]
    );
  });
});

describe("OpenCode session columns", () => {
  it("takes cwd from data.path.root when the session directory is a filesystem root", () => {
    const { session } = load(
      [
        messageRow("m1", T1, { role: "user", path: { cwd: "/" } }),
        messageRow("m2", T2, {
          role: "assistant",
          path: { cwd: 42, root: "/repos/root-only" },
        }),
        messageRow("m3", T3, {
          role: "assistant",
          path: { cwd: "/repos/ignored-once-set" },
        }),
      ],
      [],
      `UPDATE session SET directory = '/' WHERE id = '${SESSION_ID}'`
    );
    assert.equal(session.cwd, "/repos/root-only");
    assert.equal(session.name, "root-only");
  });

  it("names a cwd-less session by its title, else by its id, and nulls BLOB-typed version/slug/permission", () => {
    const titled = load(
      [USER_ROW],
      [],
      `UPDATE session SET directory = '/' WHERE id = '${SESSION_ID}'`
    ).session;
    assert.equal(titled.cwd, null);
    assert.equal(titled.name, `Title ${SESSION_ID}`);
    assert.equal(titled.version, SESSION_VERSION);
    assert.equal(titled.slug, sessionSlug(SESSION_ID));
    assert.equal(titled.permissionMode, SESSION_PERMISSION);

    const untitled = load(
      [USER_ROW, messageRow("m2", T2, { role: "user", path: "flat" })],
      [],
      `UPDATE session SET directory = X'2F', title = '', version = X'37', slug = X'38', permission = X'39' WHERE id = '${SESSION_ID}'`
    ).session;
    assert.equal(untitled.cwd, null);
    assert.equal(untitled.name, `OpenCode Session ${SESSION_ID.slice(0, 8)}`);
    assert.equal(untitled.version, null);
    assert.equal(untitled.slug, null);
    assert.equal(untitled.permissionMode, null);

    const blobTitle = load(
      [USER_ROW],
      [],
      `UPDATE session SET directory = '/', title = X'41' WHERE id = '${SESSION_ID}'`
    ).session;
    assert.equal(blobTitle.name, `OpenCode Session ${SESSION_ID.slice(0, 8)}`);
  });

  it("nulls fileModifiedAt for a zero time_updated silently, and reports a negative or non-numeric one", () => {
    const zero = load(
      [USER_ROW],
      [],
      `UPDATE session SET time_updated = 0 WHERE id = '${SESSION_ID}'`
    );
    assert.equal(zero.session.fileModifiedAt, null);
    assert.deepEqual(zero.logs, []);

    for (const cell of ["-5", "'garbage'"]) {
      const bad = load(
        [USER_ROW],
        [],
        `UPDATE session SET time_updated = ${cell} WHERE id = '${SESSION_ID}'`
      );
      assert.equal(bad.session.fileModifiedAt, null);
      assert.equal(bad.logs.length, 1);
      assert.match(bad.logs[0], UNUSABLE_EPOCH_RE);
      assert.ok(bad.logs[0].includes(`session ${SESSION_ID} in `));
    }
  });
});

describe("OpenCode part rows", () => {
  it("skips non-object parts and unknown or non-string part types", () => {
    const { session } = load(
      [USER_ROW],
      [
        partRow("p1", T2, "17"),
        partRow("p2", T2, { type: 3, text: "numeric type" }),
        partRow("p3", T2, { type: "toString", text: "prototype key" }),
      ]
    );
    assert.deepEqual(
      session.messages.map((m) => m.text),
      [null]
    );
    assert.equal(session.toolUses.length, 0);
  });

  it("records reasoning and text parts under the session model, flagging a synthetic one", () => {
    const parts = [
      partRow("p1", T2, { type: "reasoning" }),
      partRow("p2", T2, { type: "text", text: "from text" }),
      partRow("p3", T2, { type: "text", content: "from content" }),
      partRow("p4", T2, { type: "text", text: 1, content: 2 }),
    ];
    const synthetic = load(
      [USER_ROW],
      parts,
      `UPDATE session SET model = '{"id":"${OpencodeDefaultModel}"}' WHERE id = '${SESSION_ID}'`
    ).session;
    assert.equal(synthetic.thinkingBlockCount, 1);
    assert.deepEqual(
      synthetic.messages
        .slice(1)
        .map((m) => [
          m.text,
          m.isThinking ?? false,
          m.model,
          m.isSynthetic ?? false,
        ]),
      [
        [null, true, OpencodeDefaultModel, true],
        ["from text", false, OpencodeDefaultModel, true],
        ["from content", false, OpencodeDefaultModel, true],
      ]
    );

    const modelless = load(
      [USER_ROW],
      parts,
      `UPDATE session SET model = NULL WHERE id = '${SESSION_ID}'`
    ).session;
    assert.deepEqual(
      modelless.messages.slice(1).map((m) => [m.model, m.isSynthetic]),
      [
        [null, undefined],
        [null, undefined],
        [null, undefined],
      ]
    );
  });

  it("records an error part with a message and ignores one without", () => {
    const { session } = load(
      [USER_ROW],
      [
        partRow("p1", T2, { type: "error", message: "rate limited" }),
        partRow("p2", T3, { type: "error" }),
      ]
    );
    assert.deepEqual(session.apiErrors, [
      { type: "error", message: "rate limited", timestamp: iso(T2) },
    ]);
  });

  it("reads a part timestamp from time.start, then the row columns, then the session start for a tool", () => {
    const { session } = load(
      [USER_ROW],
      [
        partRow("p1", T1, { type: "tool", tool: "a", time: { start: T2 } }),
        {
          id: "p2",
          message_id: "m-user",
          time_created: null,
          time_updated: T3,
          data: JSON.stringify({ type: "tool", tool: "b" }),
        },
        {
          id: "p3",
          message_id: "m-user",
          time_created: UNPARSEABLE_TIMESTAMP,
          time_updated: UNPARSEABLE_TIMESTAMP,
          data: JSON.stringify({ type: "tool", tool: "c", time: "later" }),
        },
      ]
    );
    assert.deepEqual(
      session.toolUses.map((t) => [t.name, t.timestamp]),
      [
        ["a", iso(T2)],
        ["b", iso(T3)],
        ["c", SESSION_START_ISO],
      ]
    );
  });
});

describe("OpenCode tool parts", () => {
  it("falls back through tool, name, and a default for the tool name, and through state, input, and parameters for its input", () => {
    const { session } = load(
      [USER_ROW],
      [
        partRow("p1", T2, {
          type: "tool",
          name: "named",
          state: "not-an-object",
          parameters: { q: 1 },
        }),
        partRow("p2", T2, { type: "tool", tool: 9, name: 8, input: "raw" }),
        partRow("p3", T2, {
          type: "tool",
          tool: "t",
          state: { input: { a: 1 }, output: { ok: true } },
        }),
      ]
    );
    assert.deepEqual(
      session.toolUses.map((t) => [t.name, t.input, t.output, t.isError]),
      [
        ["named", { q: 1 }, undefined, undefined],
        ["opencode_tool", "raw", undefined, undefined],
        ["t", { a: 1 }, '{"ok":true}', undefined],
      ]
    );
    assert.deepEqual(session.toolResultErrors, []);
  });

  it("marks failed tools as errors and derives their output from the error, the output, the state, or a default", () => {
    const { session } = load(
      [USER_ROW],
      [
        partRow("p1", T2, {
          type: "tool",
          tool: "err-message",
          state: { status: "running", error: { message: "denied" } },
        }),
        partRow("p2", T2, {
          type: "tool",
          tool: "err-string-output",
          state: { status: "error", output: "stderr text" },
        }),
        partRow("p3", T2, {
          type: "tool",
          tool: "err-object-output",
          state: { status: "failed", output: { code: 2 } },
        }),
        partRow("p4", T2, {
          type: "tool",
          tool: "err-state-only",
          state: { status: "failed" },
        }),
        partRow("p5", T2, {
          type: "tool",
          tool: "err-part-error",
          error: "part level failure",
        }),
        partRow("p6", T2, {
          type: "tool",
          tool: "err-empty",
          state: { status: "error", output: "" },
        }),
      ]
    );
    assert.deepEqual(
      session.toolUses.map((t) => [t.name, t.output, t.isError]),
      [
        ["err-message", "denied", true],
        ["err-string-output", "stderr text", true],
        ["err-object-output", '{"code":2}', true],
        ["err-state-only", '{"status":"failed"}', true],
        ["err-part-error", "part level failure", true],
        ["err-empty", "OpenCode tool error", true],
      ]
    );
    assert.deepEqual(
      session.toolResultErrors.map((e) => [e.content, e.timestamp]),
      [
        ["denied", iso(T2)],
        ["stderr text", iso(T2)],
        ['{"code":2}', iso(T2)],
        ['{"status":"failed"}', iso(T2)],
        ["part level failure", iso(T2)],
        ["OpenCode tool error", iso(T2)],
      ]
    );
  });
});

describe("OpenCode patch and step-finish parts", () => {
  const PATCH = [
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    "+added",
  ].join("\n");
  const PATCH_BEFORE_TOOL = [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -0,0 +1 @@",
    "+one",
  ].join("\n");
  const PATCH_LATER = [
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1,2 +1,3 @@",
    "-x",
    "-y",
    "+z",
    "+w",
    "+v",
  ].join("\n");

  it("reads the diff from content, patch, or diff, attaches the first delta to the last tool, and never overwrites it", () => {
    const { session } = load(
      [USER_ROW],
      [
        partRow("p0", T1, { type: "patch", content: PATCH_BEFORE_TOOL }),
        partRow("p1", T2, { type: "tool", tool: "edit" }),
        partRow("p2", T2, { type: "patch", patch: PATCH }),
        partRow("p3", T3, { type: "patch", diff: PATCH_LATER }),
        partRow("p4", T3, { type: "patch", content: 1, patch: 2, diff: 3 }),
      ]
    );
    // The tool's delta is the first patch AFTER it (2/1), not the one before it
    // (1/0) and not the later one (3/2); every patch still feeds the totals.
    assert.deepEqual(session.toolUses[0].diffDelta, { add: 2, del: 1 });
    assert.deepEqual(session.diffStats, {
      filesChanged: 3,
      linesAdded: 6,
      linesRemoved: 3,
    });
  });

  it("reads step tokens from usage or tokens, and the model from the part, the session, or the synthetic default", () => {
    const withSessionModel = load(
      [USER_ROW],
      [
        partRow("p1", T1, {
          type: "step_finish",
          usage: { input: 1 },
          modelID: { modelID: "step-model" },
        }),
        partRow("p2", T2, { type: "step-finish", tokens: { output: 2 } }),
        partRow("p3", T3, { type: "step-finish", tokens: { input: 0 } }),
        partRow("p4", T3, { type: "step-finish", usage: "flat" }),
      ]
    ).session;
    assert.deepEqual(
      withSessionModel.tokenSeries.map((t) => [
        t.timestamp,
        t.model,
        t.input,
        t.output,
      ]),
      [
        [iso(T1), "step-model", 1, 0],
        [iso(T2), SESSION_MODEL_ID, 0, 2],
      ]
    );

    const modelless = load(
      [USER_ROW],
      [partRow("p1", T2, { type: "step-finish", tokens: { input: 4 } })],
      `UPDATE session SET model = NULL WHERE id = '${SESSION_ID}'`
    ).session;
    assert.deepEqual(
      modelless.tokenSeries.map((t) => [t.model, t.input]),
      [[OpencodeDefaultModel, 4]]
    );
  });

  it("dedups a step-finish against its message via the part's messageID or message_id when the row column is absent", () => {
    const { session } = load(
      [
        messageRow("m-tok", T1, {
          role: "assistant",
          tokens: { input: 10, output: 20 },
        }),
      ],
      [
        partRow(
          "p1",
          T2,
          { type: "step-finish", tokens: { input: 1 }, messageID: "m-tok" },
          null
        ),
        partRow(
          "p2",
          T2,
          { type: "step-finish", tokens: { input: 2 }, message_id: "m-tok" },
          null
        ),
        partRow(
          "p3",
          T3,
          { type: "step-finish", tokens: { input: 3 }, messageID: "m-other" },
          null
        ),
      ]
    );
    assert.deepEqual(
      session.tokenSeries.map((t) => [t.timestamp, t.input]),
      [
        [iso(T1), 10],
        [iso(T3), 3],
      ]
    );
  });

  it("drops a step-finish whose timestamp cannot be read", () => {
    const { session } = load(
      [USER_ROW],
      [
        {
          id: "p1",
          message_id: "m-user",
          time_created: UNPARSEABLE_TIMESTAMP,
          time_updated: UNPARSEABLE_TIMESTAMP,
          data: JSON.stringify({ type: "step-finish", tokens: { input: 5 } }),
        },
      ]
    );
    assert.deepEqual(session.tokenSeries, []);
  });
});

describe("OpenCode exact projections", () => {
  it("stamps the session id, entrypoint, span, and a usable time_updated as fileModifiedAt", () => {
    const { session, logs } = load([
      USER_ROW,
      messageRow("m2", T3, { role: "assistant" }),
    ]);
    assert.equal(session.sessionId, `opencode-${SESSION_ID}`);
    assert.equal(session.entrypoint, "opencode");
    assert.equal(session.startedAt, SESSION_START_ISO);
    assert.equal(session.endedAt, iso(TIME_UPDATED));
    assert.equal(session.fileModifiedAt, TIME_UPDATED);
    assert.deepEqual(logs, []);
  });

  it("does not let a skipped non-object message or part row widen the session span", () => {
    const late = TIME_UPDATED + 60_000;
    const { session } = load(
      [USER_ROW, messageRow("m-scalar", late, "42")],
      [partRow("p-scalar", late + 1, "17")]
    );
    assert.equal(session.endedAt, iso(TIME_UPDATED));
  });

  it("prefixes a monitored report with the collector's import-failed channel", () => {
    const { logs } = load(
      [USER_ROW],
      [],
      `UPDATE session SET time_updated = -5 WHERE id = '${SESSION_ID}'`
    );
    assert.equal(logs.length, 1);
    assert.ok(
      logs[0].startsWith(
        `collector opencode import failed: session ${SESSION_ID} in `
      ),
      logs[0]
    );
  });

  it("skips a non-string model alias for the next one", () => {
    const { session } = load([
      messageRow("m1", T1, {
        role: "user",
        model: { modelID: 5, id: "by-id" },
      }),
      messageRow("m2", T2, { role: "user", model: { id: 5, name: "by-name" } }),
      messageRow("m3", T3, { role: "user", model: { name: 5 } }),
    ]);
    assert.deepEqual(
      session.messages.map((m) => m.model),
      ["by-id", "by-name", SESSION_MODEL_ID]
    );
  });

  it("falls back to data.type when data.role is not a string, and prefers path.cwd over path.root", () => {
    const { session } = load(
      [
        messageRow("m1", T1, { role: 5, type: "assistant" }),
        messageRow("m2", T2, {
          role: "user",
          path: { cwd: "/repos/from-cwd", root: "/repos/from-root" },
        }),
      ],
      [],
      `UPDATE session SET directory = '/' WHERE id = '${SESSION_ID}'`
    );
    assert.equal(session.assistantMessages, 1);
    assert.equal(session.cwd, "/repos/from-cwd");
  });

  it("keeps a user message's own token counts on the message", () => {
    const { session } = load([
      messageRow("m1", T1, { role: "user", tokens: { input: 3, output: 4 } }),
    ]);
    assert.deepEqual(session.messages[0].tokens, {
      input: 3,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("labels reasoning and text parts as assistant messages", () => {
    const { session } = load(
      [USER_ROW],
      [
        partRow("p1", T2, { type: "reasoning" }),
        partRow("p2", T2, { type: "text", text: "said" }),
      ]
    );
    assert.deepEqual(
      session.messages.map((m) => m.role),
      ["human", "assistant", "assistant"]
    );
  });

  it("keeps a string tool output verbatim and caps a failed tool's stringified state and error excerpt at 500 chars", () => {
    const longText = "e".repeat(700);
    const { session } = load(
      [USER_ROW],
      [
        partRow("p1", T2, {
          type: "tool",
          tool: "ok-string",
          state: { output: "done" },
        }),
        partRow("p2", T2, {
          type: "tool",
          tool: "err-long-object",
          state: { status: "failed", output: { text: longText } },
        }),
        partRow("p3", T2, {
          type: "tool",
          tool: "err-long-message",
          state: { status: "error", error: longText },
        }),
      ]
    );
    const [okString, longObject, longMessage] = session.toolUses;
    assert.equal(okString.output, "done");
    assert.equal(
      longObject.output,
      JSON.stringify({ text: longText }).slice(0, 500)
    );
    assert.equal(longMessage.output, longText);
    assert.deepEqual(
      session.toolResultErrors.map((e) => e.content?.length),
      [500, 500]
    );
  });
});

describe("OpenCode tool result facts (ISS-12552)", () => {
  it("reads a printed operation id past the 4 KB output cap", () => {
    const operationId = "clop_01a14224-9b59-77ba-b518-16aaa9880991";
    const { session } = load(
      [USER_ROW],
      [
        partRow("p1", T1, {
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            output: `${"line\n".repeat(2000)}${operationId}`,
          },
        }),
      ]
    );

    const [tool] = session.toolUses;
    assert.ok(!String(tool?.output).includes(operationId));
    assert.deepEqual(tool?.shellOperationIds, [operationId]);
    assert.equal(tool?.resultState, ToolResultState.Present);
  });

  it("records no result facts with the attribution policy off", async () => {
    const operationId = "clop_01a14224-9b59-77ba-b518-16aaa9880991";
    const { session } = await withParsePolicy(PARSE_POLICY_BASE, () =>
      load(
        [USER_ROW],
        [
          partRow("p1", T1, {
            type: "tool",
            tool: "bash",
            state: { status: "completed", output: `printed ${operationId}` },
          }),
        ]
      )
    );

    assert.equal(session.toolUses[0]?.resultState, undefined);
    assert.equal(session.toolUses[0]?.shellOperationIds, undefined);
  });

  it("records no result facts for a part with no result", () => {
    const { session } = load(
      [USER_ROW],
      [partRow("p1", T1, { type: "tool", tool: "bash" })]
    );

    assert.equal(session.toolUses[0]?.resultState, undefined);
  });
});
