/**
 * @file opencode-subagent-fold.test.ts
 * @description ISS-4544 (Part 2 of ISS-4386): OpenCode subagent attribution.
 * An OpenCode subagent session carries a `session.parent_id` pointing at the
 * session that spawned it. These tests assert the collector folds such a child
 * under its parent's `subagents[]` at parity with the Claude/Codex sub-agent
 * roll-up (`foldCodexDescendants`): the child is removed from the top-level
 * session list, nested as a `NormalizedSubagent` keyed on its content-derived
 * raw session id (FEA-4335), and its tool-uses/tokens fold into the root.
 *
 * Fixtures are deterministic (fixed epoch timestamps, injected DB rows) — no
 * wall-clock reads — per the `test:node` determinism rule.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { createOpencodeCollector } from "../src/main/collectors/opencode/opencode-collector.js";
import {
  loadSessionParentLinksFromDb,
  loadSessionsFromDb,
  OpencodeParentLinkReadStatus,
  type OpencodeSessionLink,
  readSessionParentLinks,
} from "../src/main/collectors/opencode/opencode-parser.js";
import { foldOpencodeSubagents } from "../src/main/collectors/opencode/opencode-subagent-fold.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

/**
 * The three-table `opencode.db` schema WITH the `parent_id` column the FEA-3932
 * linkage reader (Part 1) discovers. A subagent session names its parent here.
 */
const OPENCODE_SCHEMA_WITH_PARENT_DDL = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY, parent_id TEXT, slug TEXT, directory TEXT NOT NULL,
    title TEXT NOT NULL, version TEXT NOT NULL, agent TEXT, model TEXT,
    permission TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
`;

type SessionSpec = {
  id: string;
  parentId: string | null;
  tokensInput: number;
  tokensOutput: number;
  toolName: string;
};

/** Insert one session plus a user turn, an assistant turn, and one tool part. */
function insertSession(db: DatabaseSync, spec: SessionSpec): void {
  db.prepare(`
    INSERT INTO session (
      id, parent_id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    spec.id,
    spec.parentId,
    `slug-${spec.id}`,
    "/workspace/my-project",
    `Title ${spec.id}`,
    "1.15.5",
    "build",
    JSON.stringify({ id: "oc-model", providerID: "opencode" }),
    "",
    1_710_000_000_000,
    1_710_000_060_000,
    spec.tokensInput,
    spec.tokensOutput,
    0,
    0,
    0
  );
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  );
  insertMessage.run(
    `${spec.id}-msg-user`,
    spec.id,
    1_710_000_000_000,
    1_710_000_000_000,
    JSON.stringify({ role: "user", time: { created: 1_710_000_000_000 } })
  );
  insertMessage.run(
    `${spec.id}-msg-assistant`,
    spec.id,
    1_710_000_030_000,
    1_710_000_030_000,
    JSON.stringify({
      role: "assistant",
      time: { created: 1_710_000_030_000 },
    })
  );
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    `${spec.id}-part-tool`,
    `${spec.id}-msg-assistant`,
    spec.id,
    1_710_000_031_000,
    1_710_000_031_000,
    JSON.stringify({
      type: "tool",
      tool: spec.toolName,
      time: { created: 1_710_000_031_000 },
      state: { status: "completed", output: "ok" },
    })
  );
}

/** Build a two-session `opencode.db` (root + one subagent child) at `dir`. */
function writeParentChildDb(dir: string): string {
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(OPENCODE_SCHEMA_WITH_PARENT_DDL);
  insertSession(db, {
    id: "ses_root",
    parentId: null,
    tokensInput: 100,
    tokensOutput: 20,
    toolName: "root_tool",
  });
  insertSession(db, {
    id: "ses_child",
    parentId: "ses_root",
    tokensInput: 40,
    tokensOutput: 8,
    toolName: "child_tool",
  });
  db.close();
  return dbPath;
}

function foldFromDb(dbPath: string): NormalizedSession[] {
  return foldOpencodeSubagents(
    loadSessionsFromDb(dbPath),
    loadSessionParentLinksFromDb(dbPath)
  );
}

test("OpenCode subagent session nests under its parent via session.parent_id", () => {
  const dir = makeTempDir("opencode-subagent-nest-");
  const dbPath = writeParentChildDb(dir);

  const folded = foldFromDb(dbPath);
  // Only the root survives at the top level; the child folded into it.
  assert.equal(folded.length, 1);
  const [root] = folded;
  assert.equal(root.sessionId, "opencode-ses_root");
  assert.ok(root.subagents);
  assert.equal(root.subagents?.length, 1);
});

test("OpenCode subagent identity keys off the child's content-derived session id (FEA-4335)", () => {
  const dir = makeTempDir("opencode-subagent-identity-");
  const dbPath = writeParentChildDb(dir);

  const [root] = foldFromDb(dbPath);
  const subagent = root.subagents?.[0];
  assert.ok(subagent);
  // Identity is the child's RAW opencode session id (a stable content key), not
  // a name or path.
  assert.equal(subagent?.id, "ses_child");
  assert.equal(subagent?.nativeSubagentId, "ses_child");
  assert.equal(subagent?.childSessionId, "opencode-ses_child");
  // A direct child of the root reports parentId null so the importer attaches it
  // to the main agent (parity with the Codex fold's direct-child rule).
  assert.equal(subagent?.parentId, null);
});

test("OpenCode subagent tool-uses and tokens fold into the root session", () => {
  const dir = makeTempDir("opencode-subagent-rollup-");
  const dbPath = writeParentChildDb(dir);

  const [root] = foldFromDb(dbPath);
  const subagent = root.subagents?.[0];
  assert.ok(subagent);
  // The child's tool use is tagged with its subagent id and carried on the
  // subagent entry.
  const childTool = subagent?.toolUses?.find((t) => t.name === "child_tool");
  assert.ok(childTool);
  assert.equal(childTool?.subagentId, "ses_child");
  // The root's tool-use list aggregates both its own and the child's tool uses.
  const rootToolNames = root.toolUses.map((t) => t.name).sort();
  assert.deepEqual(rootToolNames, ["child_tool", "root_tool"]);
  // The child's tool use folded onto the root carries the child's subagentId, so
  // the importer skips re-emitting its PostToolUse event under the main agent (it
  // is already emitted under the subagent) — the no-double-count guard the
  // importer keys on `tu.subagentId`, at parity with the Claude/Codex fold.
  const rootChildTool = root.toolUses.find((t) => t.name === "child_tool");
  assert.equal(rootChildTool?.subagentId, "ses_child");
  // The root's own tool use has no subagent provenance and stays on the main agent.
  const rootOwnTool = root.toolUses.find((t) => t.name === "root_tool");
  assert.equal(rootOwnTool?.subagentId, undefined);
  // The child's session-level tokens fold into the root's tokensByModel.
  assert.equal(root.tokensByModel["oc-model"].input, 100 + 40);
  assert.equal(root.tokensByModel["oc-model"].output, 20 + 8);
});

/** Insert a session plus one assistant message carrying `data.tokens` so the
 * parser emits a `tokenSeries` record for it (session-column tokens alone do
 * not produce per-message token records). */
function insertSessionWithTokenMessage(
  db: DatabaseSync,
  spec: { id: string; parentId: string | null; input: number; output: number }
): void {
  db.prepare(`
    INSERT INTO session (
      id, parent_id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    spec.id,
    spec.parentId,
    `slug-${spec.id}`,
    "/workspace/my-project",
    `Title ${spec.id}`,
    "1.15.5",
    "build",
    JSON.stringify({ id: "oc-model", providerID: "opencode" }),
    "",
    1_710_000_000_000,
    1_710_000_060_000,
    spec.input,
    spec.output,
    0,
    0,
    0
  );
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    `${spec.id}-msg-assistant`,
    spec.id,
    1_710_000_030_000,
    1_710_000_030_000,
    JSON.stringify({
      role: "assistant",
      time: { created: 1_710_000_030_000 },
      modelID: "oc-model",
      tokens: { input: spec.input, output: spec.output, cache: {} },
    })
  );
}

test("OpenCode folded child token records carry the child's subagentId (FEA-3597 round-trip provenance)", () => {
  const dir = makeTempDir("opencode-subagent-tokenprov-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(OPENCODE_SCHEMA_WITH_PARENT_DDL);
  insertSessionWithTokenMessage(db, {
    id: "ses_root",
    parentId: null,
    input: 100,
    output: 20,
  });
  insertSessionWithTokenMessage(db, {
    id: "ses_child",
    parentId: "ses_root",
    input: 40,
    output: 8,
  });
  db.close();

  const [root] = foldFromDb(dbPath);
  assert.ok(root.tokenSeries.length > 0);
  // Every folded child token record must be stamped with the child's raw id, or
  // `deriveSessionTurnBuckets` reads the missing marker as "parent" and lands the
  // child's round trip on the root agent timeline. The root's OWN records stay
  // unstamped (parent provenance).
  const childRecords = root.tokenSeries.filter(
    (record) => record.subagentId === "ses_child"
  );
  assert.ok(
    childRecords.length > 0,
    "at least one child token record folds onto the root stamped with its subagentId"
  );
  const parentRecords = root.tokenSeries.filter(
    (record) => record.subagentId === undefined
  );
  assert.ok(
    parentRecords.length > 0,
    "the root's own token records keep parent provenance (no subagentId)"
  );
  // The nested subagent entry mirrors the same stamped series.
  const subagentSeries = root.subagents?.[0]?.tokenSeries ?? [];
  assert.ok(subagentSeries.length > 0);
  assert.ok(
    subagentSeries.every((record) => record.subagentId === "ses_child"),
    "the subagent entry's own tokenSeries is fully stamped with its id"
  );
});

test("OpenCode fold recomputes root artifacts so a child-only PR ref surfaces on the root", () => {
  const dir = makeTempDir("opencode-subagent-artifacts-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(OPENCODE_SCHEMA_WITH_PARENT_DDL);
  // Root has an ordinary tool with no artifact ref.
  insertSession(db, {
    id: "ses_root",
    parentId: null,
    tokensInput: 100,
    tokensOutput: 20,
    toolName: "root_tool",
  });
  // Child runs a bash tool whose output contains a PR URL — the ONLY artifact
  // reference in the whole batch, and it lives on the folded child.
  const childPrUrl =
    "https://github.com/closedloop-ai/symphony-alpha/pull/4097";
  db.prepare(`
    INSERT INTO session (
      id, parent_id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "ses_child",
    "ses_root",
    "slug-ses_child",
    "/workspace/my-project",
    "Title ses_child",
    "1.15.5",
    "build",
    JSON.stringify({ id: "oc-model", providerID: "opencode" }),
    "",
    1_710_000_000_000,
    1_710_000_060_000,
    40,
    8,
    0,
    0,
    0
  );
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    "ses_child-msg-assistant",
    "ses_child",
    1_710_000_030_000,
    1_710_000_030_000,
    JSON.stringify({ role: "assistant", time: { created: 1_710_000_030_000 } })
  );
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "ses_child-part-tool",
    "ses_child-msg-assistant",
    "ses_child",
    1_710_000_031_000,
    1_710_000_031_000,
    JSON.stringify({
      type: "tool",
      tool: "bash",
      time: { created: 1_710_000_031_000 },
      state: {
        status: "completed",
        output: `Created PR ${childPrUrl}`,
      },
    })
  );
  db.close();

  const [root] = foldFromDb(dbPath);
  // The child-only PR ref is reconciled onto the root's artifacts after the fold
  // (parity with foldCodexDescendants' `collectArtifacts` recompute); without the
  // recompute the reference is lost when the child leaves the top level.
  const rootPrUrls = root.artifacts.prs.map((pr) => pr.url);
  assert.ok(
    rootPrUrls.includes(childPrUrl),
    `root artifacts include the child-only PR ref; got ${JSON.stringify(rootPrUrls)}`
  );
});

test("OpenCode collector.parse folds subagents on the production import path", async () => {
  const dir = makeTempDir("opencode-subagent-collector-");
  writeParentChildDb(dir);
  const collector = createOpencodeCollector({ dataDir: dir });

  const sessions = await collector.parse(path.join(dir, "opencode.db"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, "opencode-ses_root");
  assert.equal(sessions[0].subagents?.length, 1);
  assert.equal(sessions[0].subagents?.[0].id, "ses_child");
});

test("OpenCode nested subagent chain reports its direct subagent parent", () => {
  const dir = makeTempDir("opencode-subagent-chain-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(OPENCODE_SCHEMA_WITH_PARENT_DDL);
  // root → child → grandchild.
  insertSession(db, {
    id: "ses_root",
    parentId: null,
    tokensInput: 10,
    tokensOutput: 2,
    toolName: "root_tool",
  });
  insertSession(db, {
    id: "ses_child",
    parentId: "ses_root",
    tokensInput: 20,
    tokensOutput: 4,
    toolName: "child_tool",
  });
  insertSession(db, {
    id: "ses_grandchild",
    parentId: "ses_child",
    tokensInput: 30,
    tokensOutput: 6,
    toolName: "grandchild_tool",
  });
  db.close();

  const folded = foldFromDb(dbPath);
  // The whole chain collapses under the single root.
  assert.equal(folded.length, 1);
  const [root] = folded;
  assert.equal(root.subagents?.length, 2);
  const grandchild = root.subagents?.find((s) => s.id === "ses_grandchild");
  const child = root.subagents?.find((s) => s.id === "ses_child");
  // The grandchild's parent is the intermediate subagent (its raw id), while the
  // direct child of the root reports null.
  assert.equal(grandchild?.parentId, "ses_child");
  assert.equal(child?.parentId, null);
  // All three sessions' tokens roll up into the root.
  assert.equal(root.tokensByModel["oc-model"].input, 10 + 20 + 30);
});

test("OpenCode sessions stay top-level when the DB has no parent_id column (fallback)", () => {
  const dir = makeTempDir("opencode-subagent-noparent-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  // Legacy schema WITHOUT parent_id — the linkage reader returns [], so every
  // session must remain a root (documented fallback, materializer parity).
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, slug TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, agent TEXT, model TEXT, permission TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  );
  for (const id of ["ses_a", "ses_b"]) {
    db.prepare(`
      INSERT INTO session (
        id, slug, directory, title, version, agent, model, permission,
        time_created, time_updated, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      `slug-${id}`,
      "/workspace/my-project",
      `Title ${id}`,
      "1.15.5",
      "build",
      JSON.stringify({ id: "oc-model", providerID: "opencode" }),
      "",
      1_710_000_000_000,
      1_710_000_060_000,
      10,
      2,
      0,
      0,
      0
    );
    insertMessage.run(
      `${id}-msg`,
      id,
      1_710_000_000_000,
      1_710_000_000_000,
      JSON.stringify({ role: "user", time: { created: 1_710_000_000_000 } })
    );
  }
  db.close();

  const folded = foldFromDb(dbPath);
  assert.equal(folded.length, 2);
  for (const session of folded) {
    assert.equal(session.subagents, undefined);
  }
});

// ---------------------------------------------------------------------------
// ISS-4649 (finding 6) — a FAILED linkage read must not masquerade as a legacy
// (no-`parent_id`) DB.
//
// Collapsing both to `[]` un-nests every subagent for that import tick, and the
// collector's fingerprint gate then skips re-reading the unchanged DB, freezing
// the flattened corpus in place. `readSessionParentLinks` reports the two apart,
// and the collector refuses the import rather than persisting the flat result.
// ---------------------------------------------------------------------------

test("ISS-4649: a legacy DB (no parent_id column) reads as Legacy, not Unreadable", () => {
  const dir = makeTempDir("opencode-linkread-legacy-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);");
  db.close();

  const read = readSessionParentLinks(dbPath);
  assert.equal(read.status, OpencodeParentLinkReadStatus.Legacy);
});

test("ISS-4649: a missing DB reads as Legacy (nothing to nest, nothing failed)", () => {
  const dir = makeTempDir("opencode-linkread-missing-");
  const read = readSessionParentLinks(path.join(dir, "absent.db"));
  assert.equal(read.status, OpencodeParentLinkReadStatus.Legacy);
});

test("ISS-4649: an unreadable DB reads as Unreadable, NOT as a legacy empty", () => {
  const dir = makeTempDir("opencode-linkread-corrupt-");
  const dbPath = path.join(dir, "opencode.db");
  // A file that is not a SQLite database at all — the open (or first read) fails.
  fs.writeFileSync(dbPath, "this is not a sqlite database");

  const read = readSessionParentLinks(dbPath);
  assert.equal(
    read.status,
    OpencodeParentLinkReadStatus.Unreadable,
    "a failed read must be distinguishable from a legacy schema"
  );
  // The compatibility shim still flattens both to `[]` for callers that cannot
  // act on the difference (the materializer + its existing tests).
  assert.deepEqual(loadSessionParentLinksFromDb(dbPath), []);
});

test("ISS-4649: the collector REFUSES the import when the DB cannot be read", async () => {
  const dir = makeTempDir("opencode-collector-corrupt-");
  fs.writeFileSync(path.join(dir, "opencode.db"), "not a sqlite database");
  const collector = createOpencodeCollector({ dataDir: dir });

  // Rejecting means the engine skips this source, so `markSourceImported` never
  // advances the fingerprint and the next tick retries — instead of persisting a
  // corpus built on an incomplete read that the fingerprint gate would then
  // freeze in place. (An unreadable file trips the session read first; the
  // linkage-specific refusal is pinned by the `Unreadable` status test above,
  // which covers the case where only the SECOND connection fails — the two are
  // independent opens, so a lock can hit one and not the other.)
  await assert.rejects(
    async () => await collector.parse(path.join(dir, "opencode.db"))
  );
});

/**
 * The monitored channel's message shape: the same
 * `collector <key> import failed: …` prefix `CollectorManager` emits, plus the
 * reason and the underlying SQLite error carried for triage.
 */
const MONITORED_IMPORT_FAILURE_PREFIX_RE =
  /^collector opencode import failed: /;
const UNREADABLE_LINKAGE_REASON_RE = /parent linkage unreadable/;
const UNDERLYING_SQLITE_ERROR_RE = /database is locked/;

test("ISS-4649: an unreadable LINKAGE on an otherwise-loadable DB refuses the tick and logs on the monitored channel", async () => {
  // wongk review: the corrupt-file case above dies in `loadSessionsFromDb`, so it
  // never reaches the linkage branch. Drive that branch directly, over a VALID
  // DB whose sessions load fine — the shape a SQLITE_BUSY on the second
  // connection produces (the two opens are independent).
  const dir = makeTempDir("opencode-collector-linkage-busy-");
  writeParentChildDb(dir);
  const logs: string[] = [];
  const collector = createOpencodeCollector({
    dataDir: dir,
    log: (message) => logs.push(message),
    readParentLinks: () => ({
      error: new Error("database is locked"),
      status: OpencodeParentLinkReadStatus.Unreadable,
    }),
  });

  await assert.rejects(
    async () => await collector.parse(path.join(dir, "opencode.db"))
  );
  // Rejecting alone is invisible: `CollectorManager.importSources` catches a
  // per-source parse rejection and continues WITHOUT logging, so the refusal has
  // to be reported here, on the same monitored channel the manager uses.
  assert.equal(logs.length, 1, `expected one log line; got ${logs.length}`);
  assert.match(logs[0], MONITORED_IMPORT_FAILURE_PREFIX_RE);
  assert.match(logs[0], UNREADABLE_LINKAGE_REASON_RE);
  assert.match(logs[0], UNDERLYING_SQLITE_ERROR_RE);
});

test("ISS-4649: a readable linkage still folds and logs nothing", async () => {
  // The negative half: the monitored channel must stay silent on the happy path,
  // or the signal is worthless.
  const dir = makeTempDir("opencode-collector-linkage-ok-");
  writeParentChildDb(dir);
  const logs: string[] = [];
  const collector = createOpencodeCollector({
    dataDir: dir,
    log: (message) => logs.push(message),
  });

  const sessions = await collector.parse(path.join(dir, "opencode.db"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].subagents?.length, 1);
  assert.deepEqual(logs, []);
});

// ---------------------------------------------------------------------------
// ISS-4649 (finding 7) — the parent-chain walk is memoized per fold pass.
// These pin the OBSERVABLE outcomes the memo must not change.
// ---------------------------------------------------------------------------

test("ISS-4649: a parent cycle still yields top-level sessions (memo is cycle-safe)", () => {
  // A malformed graph (a ↔ b) must never loop, throw, or vanish a session. Every
  // member of the cycle is a "child" whose resolved root is itself inside the
  // cycle, so no root row is emitted and the orphan re-emit path returns both as
  // top-level — the same outcome as the un-memoized walk.
  const sessions: NormalizedSession[] = [
    makeMinimalSession("opencode-ses_a"),
    makeMinimalSession("opencode-ses_b"),
  ];
  const folded = foldOpencodeSubagents(sessions, [
    { sessionId: "ses_a", parentId: "ses_b" },
    { sessionId: "ses_b", parentId: "ses_a" },
  ]);

  assert.equal(folded.length, 2);
  assert.deepEqual(folded.map((s) => s.sessionId).sort(), [
    "opencode-ses_a",
    "opencode-ses_b",
  ]);
});

test("ISS-4649: a deep chain folds every descendant onto the one true root", () => {
  // Siblings sharing a parent, plus depth, is exactly the shape the memo turns
  // from O(n·d) into O(n). The bucketing must be unchanged: one root, all others
  // as subagents.
  const depth = 40;
  const sessions: NormalizedSession[] = [makeMinimalSession("opencode-ses_0")];
  const links: OpencodeSessionLink[] = [{ sessionId: "ses_0", parentId: null }];
  for (let index = 1; index <= depth; index += 1) {
    sessions.push(makeMinimalSession(`opencode-ses_${index}`));
    links.push({ sessionId: `ses_${index}`, parentId: `ses_${index - 1}` });
    // A sibling forked off the same parent — shares the whole ancestor chain.
    sessions.push(makeMinimalSession(`opencode-sib_${index}`));
    links.push({ sessionId: `sib_${index}`, parentId: `ses_${index - 1}` });
  }

  const folded = foldOpencodeSubagents(sessions, links);

  assert.equal(folded.length, 1, "everything folds onto the single root");
  assert.equal(folded[0].sessionId, "opencode-ses_0");
  assert.equal(folded[0].subagents?.length, depth * 2);
});

// ---------------------------------------------------------------------------
// ISS-5302 — the third outcome, and the one row shape the link loop skips.
//
// `Legacy` and `Unreadable` are pinned above. `Linked` is asserted here as its
// own STATUS rather than inferred from a non-empty array, because all three
// outcomes can present as "no links to act on" and only the status tells a
// transient lock apart from a schema that never had the column.
// ---------------------------------------------------------------------------

test("ISS-5302: a DB WITH a parent_id column reads as Linked, carrying every row's linkage", () => {
  const dir = makeTempDir("opencode-linkread-linked-");
  const dbPath = writeParentChildDb(dir);

  const read = readSessionParentLinks(dbPath);
  assert.equal(read.status, OpencodeParentLinkReadStatus.Linked);
  const links =
    read.status === OpencodeParentLinkReadStatus.Linked ? read.links : [];
  // Every session is reported, parent or not: the root's explicit `null` is the
  // linkage answer "this one is top-level", which the fold needs in order to
  // pick a root at all. Sorted because the read carries no ORDER BY.
  assert.deepEqual(
    [...links].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    [
      { parentId: "ses_root", sessionId: "ses_child" },
      { parentId: null, sessionId: "ses_root" },
    ]
  );
});

test("ISS-5302: a session row with a NULL id is skipped, never filed under a stringified null", () => {
  const dir = makeTempDir("opencode-linkread-nullid-");
  const dbPath = writeParentChildDb(dir);
  // SQLite lets a non-INTEGER PRIMARY KEY hold NULL (the documented legacy
  // quirk), so a corrupt store really can carry an id-less session row. Written
  // against the same table the fixture above created — a second schema copy is
  // the drift the shared fixture exists to prevent.
  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO session (
      id, parent_id, directory, title, version, time_created, time_updated
    ) VALUES (NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    "ses_root",
    "/workspace/my-project",
    "Title (id-less row)",
    "1.15.5",
    1_710_000_000_000,
    1_710_000_060_000
  );
  db.close();

  const read = readSessionParentLinks(dbPath);
  // The row is skipped, not coerced: `String(null)` would invent the session id
  // "null" and hand the fold a parent claim for a session no store ever held.
  assert.equal(read.status, OpencodeParentLinkReadStatus.Linked);
  const links =
    read.status === OpencodeParentLinkReadStatus.Linked ? read.links : [];
  assert.deepEqual(
    [...links].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    [
      { parentId: "ses_root", sessionId: "ses_child" },
      { parentId: null, sessionId: "ses_root" },
    ]
  );
  // And skipping one row does not demote the read: the column was there and was
  // read, so the status stays `Linked` and the collector still imports.
  assert.equal(
    links.some((link) => link.sessionId === "null"),
    false
  );
});

/** The smallest session shape the fold needs; content is irrelevant here. */
function makeMinimalSession(sessionId: string): NormalizedSession {
  return {
    sessionId,
    harness: "opencode",
    cwd: "/workspace/my-project",
    startedAt: new Date(1_710_000_000_000).toISOString(),
    endedAt: new Date(1_710_000_060_000).toISOString(),
    status: "completed",
    events: [],
    toolUses: [],
    tokenSeries: [],
    tokensByModel: {},
  } as unknown as NormalizedSession;
}
