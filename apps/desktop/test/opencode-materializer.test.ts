/**
 * @file opencode-materializer.test.ts
 * @description FEA-3932: the OpenCode materializer with injected DB loaders and
 * a fake in-memory filesystem. Covers deterministic byte-identical output, the
 * DB-fingerprint revision gate (unchanged DB → no rewrite), subagent nesting
 * under the parent's externalSessionId, and round-trip parity with the cloud
 * parser core.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOpenCodeTranscript } from "@repo/lib/harness/opencode/parse-opencode";
import type {
  OpencodeDroppedSession,
  OpencodeSessionLoad,
} from "../src/main/collectors/opencode/opencode-parse-failure.js";
import {
  OpencodeParentLinkReadStatus,
  type OpencodeSessionLink,
} from "../src/main/collectors/opencode/opencode-parser.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import {
  materializeOpencodeTranscripts,
  opencodeMaterializerFingerprintPath,
  serializeSessionToJsonl,
} from "../src/main/transcript-sync/opencode-materializer.js";
import { makeSession } from "./normalized-session-test-utils.js";

import {
  dbStats,
  type FakeFs,
  fakeFs,
  HOME,
  linked,
  loaded,
  ROOT,
  STATE_DIR,
} from "./opencode-materializer-test-utils.js";

/**
 * The `rev:<n>|` component the checkpoint fingerprint leads with. Stripping it
 * reproduces the fingerprint a build predating the projection revision wrote.
 */
const PROJECTION_REVISION_PREFIX_RE = /^rev:\d+\|/;

test("materializer writes a root session to <root>/<externalSessionId>/main.jsonl", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const session = makeSession({
    sessionId: "opencode-abc",
    entrypoint: "opencode",
  });
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded([session]),
    readParentLinks: () => linked([{ sessionId: "abc", parentId: null }]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  const mainPath = `${ROOT}/opencode-abc/main.jsonl`;
  assert.ok(fs.files.has(mainPath), "main.jsonl written");
  const firstLine = fs.files.get(mainPath)?.split("\n")[0];
  assert.ok(firstLine);
  const parsed = JSON.parse(firstLine);
  assert.equal(parsed.t, "session");
  assert.equal(parsed.sessionId, "opencode-abc");
});

test("materializer nests a child session under the parent's externalSessionId (FEA-3932 sub-chains)", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const root = makeSession({
    sessionId: "opencode-root",
    entrypoint: "opencode",
  });
  const child = makeSession({
    sessionId: "opencode-child",
    entrypoint: "opencode",
  });
  const links: OpencodeSessionLink[] = [
    { sessionId: "root", parentId: null },
    { sessionId: "child", parentId: "root" },
  ];
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded([root, child]),
    readParentLinks: () => linked(links),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  assert.ok(fs.files.has(`${ROOT}/opencode-root/main.jsonl`));
  // The child files under the ROOT session's externalSessionId as subagent:child.
  assert.ok(fs.files.has(`${ROOT}/opencode-root/subagent:child.jsonl`));
  assert.ok(!fs.files.has(`${ROOT}/opencode-child/main.jsonl`));
});

test("materializer output is deterministic (byte-identical across runs)", () => {
  const session = makeSession({
    sessionId: "opencode-abc",
    entrypoint: "opencode",
  });
  const fsA = fakeFs(dbStats(1000, 10));
  const fsB = fakeFs(dbStats(1000, 10));
  const run = (fs: FakeFs) =>
    materializeOpencodeTranscripts(STATE_DIR, {
      loadSessions: () => loaded([session]),
      readParentLinks: () => linked([{ sessionId: "abc", parentId: null }]),
      openCodeHome: () => HOME,
      fsImpl: fs,
    });
  run(fsA);
  run(fsB);
  const path = `${ROOT}/opencode-abc/main.jsonl`;
  assert.equal(fsA.files.get(path), fsB.files.get(path));
});

test("materializer revision-gate: unchanged DB fingerprint → loader NOT called, no rewrite", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const session = makeSession({
    sessionId: "opencode-abc",
    entrypoint: "opencode",
  });
  let loadCount = 0;
  const deps = {
    loadSessions: () => {
      loadCount++;
      return loaded([session]);
    },
    readParentLinks: () => linked([{ sessionId: "abc", parentId: null }]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  };
  materializeOpencodeTranscripts(STATE_DIR, deps);
  assert.equal(loadCount, 1);
  // Second run with the SAME db stats: the fingerprint matches, so the load is
  // skipped entirely (no re-parse, no rewrite → no re-upload).
  materializeOpencodeTranscripts(STATE_DIR, deps);
  assert.equal(loadCount, 1);
});

test("ISS-5238: a checkpoint from a build with an older PROJECTION revision re-derives against an unchanged DB", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const session = makeSession({
    sessionId: "opencode-abc",
    entrypoint: "opencode",
  });
  let loadCount = 0;
  const deps = {
    loadSessions: () => {
      loadCount++;
      return loaded([session]);
    },
    readParentLinks: () => linked([{ sessionId: "abc", parentId: null }]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  };
  materializeOpencodeTranscripts(STATE_DIR, deps);
  assert.equal(loadCount, 1, "sweep 1 parsed and checkpointed");

  // Simulate the upgrade wongk flagged: the checkpoint on disk was written by a
  // build whose serializer predates this one, while `opencode.db` has not been
  // touched since. Strip the projection-revision component to reproduce exactly
  // what that older build persisted. Without a revision in the fingerprint the
  // store looks unchanged, the sweep returns early, and the stale `.jsonl` the
  // cloud rejects is served until the user happens to touch the DB again.
  const fingerprintPath = opencodeMaterializerFingerprintPath(STATE_DIR);
  const current = fs.files.get(fingerprintPath);
  assert.ok(current, "sweep 1 wrote a checkpoint");
  const legacy = current.replace(PROJECTION_REVISION_PREFIX_RE, "");
  assert.notEqual(
    legacy,
    current,
    "the checkpoint carries a projection-revision component to strip"
  );
  fs.files.set(fingerprintPath, legacy);

  materializeOpencodeTranscripts(STATE_DIR, deps);
  assert.equal(
    loadCount,
    2,
    "the older-revision checkpoint does not gate the corrected serializer — the store is re-derived"
  );
  assert.equal(
    fs.files.get(fingerprintPath),
    current,
    "and the checkpoint is rewritten at the current projection revision"
  );
});

test("ISS-4649: an UNREADABLE parent linkage writes nothing, prunes nothing, and leaves the fingerprint unadvanced", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const root = makeSession({
    sessionId: "opencode-root",
    entrypoint: "opencode",
  });
  const child = makeSession({
    sessionId: "opencode-child",
    entrypoint: "opencode",
  });
  const links: OpencodeSessionLink[] = [
    { sessionId: "root", parentId: null },
    { sessionId: "child", parentId: "root" },
  ];
  // First sweep reads the linkage cleanly: the child nests under the root.
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded([root, child]),
    readParentLinks: () => linked(links),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  const nestedPath = `${ROOT}/opencode-root/subagent:child.jsonl`;
  assert.ok(fs.files.has(nestedPath), "child materialized as a subagent");
  const fingerprintAfterGoodRun = fs.files.get(
    opencodeMaterializerFingerprintPath(STATE_DIR)
  );
  assert.ok(fingerprintAfterGoodRun);

  // The DB changes (so the revision gate does NOT short-circuit) and the linkage
  // read now FAILS — e.g. a SQLITE_BUSY past the busy timeout. Nothing about the
  // session load failed, so a bare `[]` fallback would look entirely healthy: it
  // would re-root the child as its own `main.jsonl`, prune the correct
  // `subagent:child.jsonl`, and advance the fingerprint past the damage.
  for (const key of Object.keys(dbStats(2000, 20))) {
    fs.stats.set(key, { mtimeMs: 2000, size: 20 });
  }
  let loadCount = 0;
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => {
      loadCount++;
      return loaded([root, child]);
    },
    readParentLinks: () => ({
      error: new Error("database is locked"),
      status: OpencodeParentLinkReadStatus.Unreadable,
    }),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });

  assert.equal(loadCount, 1, "the revision gate let this sweep through");
  assert.ok(
    fs.files.has(nestedPath),
    "the correct nested projection survives an unreadable linkage read"
  );
  assert.ok(
    !fs.files.has(`${ROOT}/opencode-child/main.jsonl`),
    "the child is NOT re-rooted as its own top-level session"
  );
  assert.equal(
    fs.files.get(opencodeMaterializerFingerprintPath(STATE_DIR)),
    fingerprintAfterGoodRun,
    "the fingerprint stays unadvanced so the next sweep retries"
  );
});

test("materializer re-materializes when the DB fingerprint changes", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const session = makeSession({
    sessionId: "opencode-abc",
    entrypoint: "opencode",
  });
  let loadCount = 0;
  const deps = () => ({
    loadSessions: () => {
      loadCount++;
      return loaded([session]);
    },
    readParentLinks: () => linked([{ sessionId: "abc", parentId: null }]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  materializeOpencodeTranscripts(STATE_DIR, deps());
  assert.equal(loadCount, 1);
  // DB changed (new mtime/size) → fingerprint differs → re-parse + rewrite.
  for (const key of Object.keys(dbStats(2000, 20))) {
    fs.stats.set(key, { mtimeMs: 2000, size: 20 });
  }
  materializeOpencodeTranscripts(STATE_DIR, deps());
  assert.equal(loadCount, 2);
});

test("materializer withholds the fingerprint when a per-session write fails (retry preserved)", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const ok = makeSession({ sessionId: "opencode-ok", entrypoint: "opencode" });
  const bad = makeSession({
    sessionId: "opencode-bad",
    entrypoint: "opencode",
  });
  let writeCount = 0;
  // Fail the write for the `bad` session only (its temp write throws).
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = (p, data) => {
    if (p.includes("opencode-bad")) {
      writeCount++;
      throw new Error("EACCES");
    }
    origWrite(p, data);
  };
  const deps = {
    loadSessions: () => loaded([ok, bad]),
    readParentLinks: () =>
      linked([
        { sessionId: "ok", parentId: null },
        { sessionId: "bad", parentId: null },
      ]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  };
  materializeOpencodeTranscripts(STATE_DIR, deps);
  assert.ok(
    fs.files.has(`${ROOT}/opencode-ok/main.jsonl`),
    "good session written"
  );
  // Fingerprint NOT persisted (a write failed) → the next unchanged-DB run
  // re-attempts the whole batch instead of returning early on a match.
  const secondWrites = writeCount;
  materializeOpencodeTranscripts(STATE_DIR, deps);
  assert.ok(
    writeCount > secondWrites,
    "bad session re-attempted on next sweep"
  );
});

test("materializer prunes a projection whose session was deleted from opencode.db", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const a = makeSession({ sessionId: "opencode-a", entrypoint: "opencode" });
  const b = makeSession({ sessionId: "opencode-b", entrypoint: "opencode" });
  const makeDeps = (sessions: (typeof a)[], links: OpencodeSessionLink[]) => ({
    loadSessions: () => loaded(sessions),
    readParentLinks: () => linked(links),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  materializeOpencodeTranscripts(
    STATE_DIR,
    makeDeps(
      [a, b],
      [
        { sessionId: "a", parentId: null },
        { sessionId: "b", parentId: null },
      ]
    )
  );
  assert.ok(fs.files.has(`${ROOT}/opencode-a/main.jsonl`));
  assert.ok(fs.files.has(`${ROOT}/opencode-b/main.jsonl`));
  // `b` deleted from the DB; DB fingerprint changes → re-materialize + prune.
  for (const key of Object.keys(dbStats(2000, 20))) {
    fs.stats.set(key, { mtimeMs: 2000, size: 20 });
  }
  materializeOpencodeTranscripts(
    STATE_DIR,
    makeDeps([a], [{ sessionId: "a", parentId: null }])
  );
  assert.ok(
    fs.files.has(`${ROOT}/opencode-a/main.jsonl`),
    "surviving session kept"
  );
  assert.ok(
    !fs.files.has(`${ROOT}/opencode-b/main.jsonl`),
    "deleted session's projection pruned"
  );
});

test("materializer prunes the old file key when a child is reparented", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const root = makeSession({
    sessionId: "opencode-root",
    entrypoint: "opencode",
  });
  const child = makeSession({
    sessionId: "opencode-child",
    entrypoint: "opencode",
  });
  const makeDeps = (links: OpencodeSessionLink[]) => ({
    loadSessions: () => loaded([root, child]),
    readParentLinks: () => linked(links),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  // First: child is a ROOT (its own main.jsonl).
  materializeOpencodeTranscripts(
    STATE_DIR,
    makeDeps([
      { sessionId: "root", parentId: null },
      { sessionId: "child", parentId: null },
    ])
  );
  assert.ok(fs.files.has(`${ROOT}/opencode-child/main.jsonl`));
  // Reparent child under root; fingerprint changes → re-materialize + prune.
  for (const key of Object.keys(dbStats(2000, 20))) {
    fs.stats.set(key, { mtimeMs: 2000, size: 20 });
  }
  materializeOpencodeTranscripts(
    STATE_DIR,
    makeDeps([
      { sessionId: "root", parentId: null },
      { sessionId: "child", parentId: "root" },
    ])
  );
  assert.ok(
    fs.files.has(`${ROOT}/opencode-root/subagent:child.jsonl`),
    "child now filed under root"
  );
  assert.ok(
    !fs.files.has(`${ROOT}/opencode-child/main.jsonl`),
    "old root-child main.jsonl pruned"
  );
});

test("materializer rejects a traversal-bearing session id (containment guard)", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const evil = makeSession({
    sessionId: "opencode-../../escape",
    entrypoint: "opencode",
  });
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded([evil]),
    readParentLinks: () =>
      linked([{ sessionId: "../../escape", parentId: null }]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  // Nothing was written outside the root (the write threw and was caught).
  for (const p of fs.files.keys()) {
    assert.ok(
      p.startsWith(ROOT) || p.startsWith(STATE_DIR),
      `no file escaped the root: ${p}`
    );
  }
});

test("materializer publishes via a same-directory temp + rename (no partial file visible)", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const session = makeSession({
    sessionId: "opencode-abc",
    entrypoint: "opencode",
  });
  const renamedTargets: string[] = [];
  const origRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    assert.ok(from.endsWith(".tmp"), "writes go through a .tmp temp file");
    renamedTargets.push(to);
    origRename(from, to);
  };
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded([session]),
    readParentLinks: () => linked([{ sessionId: "abc", parentId: null }]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  assert.deepEqual(renamedTargets, [`${ROOT}/opencode-abc/main.jsonl`]);
  // No leftover temp file remains after the rename.
  for (const p of fs.files.keys()) {
    assert.ok(!p.endsWith(".tmp"), `no temp file left behind: ${p}`);
  }
});

test("serializeSessionToJsonl round-trips through the cloud parser core", async () => {
  const session = makeSession({
    sessionId: "opencode-abc",
    name: "Demo",
    entrypoint: "opencode",
    userMessages: 1,
    assistantMessages: 1,
    messages: [
      { role: "human", timestamp: "2026-01-01T00:00:00.000Z", text: "hi" },
      {
        role: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        text: "hello",
        model: "test-model",
      },
    ],
    toolUses: [
      {
        name: "Bash",
        timestamp: "2026-01-01T00:00:02.000Z",
        input: { cmd: "ls" },
      },
    ],
    tokenSeries: [
      {
        timestamp: "2026-01-01T00:00:01.000Z",
        model: "test-model",
        input: 10,
        output: 5,
        cacheRead: 1,
        cacheWrite: 2,
      },
    ],
    tokensByModel: {
      "test-model": { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 },
    },
  });
  const jsonl = serializeSessionToJsonl(session);
  const reparsed = await parseOpenCodeTranscript(jsonl.split("\n"), {
    sessionId: "opencode-abc",
  });
  assert.ok(reparsed);
  assert.equal(reparsed.sessionId, "opencode-abc");
  assert.equal(reparsed.name, "Demo");
  assert.equal(reparsed.entrypoint, "opencode");
  assert.equal(reparsed.messages.length, 2);
  assert.equal(reparsed.messages[1]?.text, "hello");
  assert.equal(reparsed.toolUses.length, 1);
  assert.equal(reparsed.toolUses[0]?.name, "Bash");
  assert.equal(reparsed.tokenSeries.length, 1);
  assert.deepEqual(reparsed.tokensByModel, {
    "test-model": { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 },
  });
});

/** A LOSSY load: `sessions` parsed, `dropped` did not (ISS-5238 F1 drops). */
function partiallyLoaded(
  sessions: NormalizedSession[],
  dropped: OpencodeDroppedSession[]
): OpencodeSessionLoad {
  return { sessions, droppedSessions: dropped };
}

test("ISS-5238 F3: a SHORT load does NOT delete the dropped session's existing projection", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const a = makeSession({ sessionId: "opencode-a", entrypoint: "opencode" });
  const b = makeSession({ sessionId: "opencode-b", entrypoint: "opencode" });
  const links = [
    { sessionId: "a", parentId: null },
    { sessionId: "b", parentId: null },
  ];
  // Sweep 1: both sessions parse, both projections publish.
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded([a, b]),
    readParentLinks: () => linked(links),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  const bProjection = `${ROOT}/opencode-b/main.jsonl`;
  const bBody = fs.files.get(bProjection);
  assert.ok(bBody, "sweep 1 published b's projection");
  const fingerprintPath = opencodeMaterializerFingerprintPath(STATE_DIR);
  const sweepOneFingerprint = fs.files.get(fingerprintPath);
  assert.ok(sweepOneFingerprint, "sweep 1 checkpointed");

  // Sweep 2: the DB changed, and `b`'s row FAILED TO PARSE — it is still in
  // `opencode.db`, we simply could not read it. Before ISS-5238 this was
  // indistinguishable from "b was deleted", so the prune `rmSync`'d b's
  // still-correct projection and the fingerprint advanced past the damage.
  const logs: string[] = [];
  fs.stats.set(`${HOME}/opencode.db`, { mtimeMs: 2000, size: 20 });
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () =>
      partiallyLoaded(
        [a],
        [{ sessionId: "b", reason: "Invalid token count for x" }]
      ),
    readParentLinks: () => linked(links),
    openCodeHome: () => HOME,
    fsImpl: fs,
    log: (message) => logs.push(message),
  });
  assert.equal(
    fs.files.get(bProjection),
    bBody,
    "b's projection survives a short load byte-for-byte"
  );
  assert.ok(
    logs.some((message) => message.includes("opencode materialize incomplete")),
    "the short load is reported on the diagnostic sink"
  );
  assert.notEqual(
    fs.files.get(fingerprintPath),
    sweepOneFingerprint,
    "a dropped session is durable, so the checkpoint still advances — SCOPING the prune to the dropped session is what preserves the projection, and withholding the checkpoint too would re-parse the whole DB on every sweep forever"
  );
});

test("ISS-5238 F3: a lossless load still prunes a genuinely deleted session", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const a = makeSession({ sessionId: "opencode-a", entrypoint: "opencode" });
  const b = makeSession({ sessionId: "opencode-b", entrypoint: "opencode" });
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded([a, b]),
    readParentLinks: () =>
      linked([
        { sessionId: "a", parentId: null },
        { sessionId: "b", parentId: null },
      ]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  assert.ok(fs.files.has(`${ROOT}/opencode-b/main.jsonl`));
  const fingerprintPath = opencodeMaterializerFingerprintPath(STATE_DIR);
  const sweepOneFingerprint = fs.files.get(fingerprintPath);
  assert.ok(sweepOneFingerprint, "sweep 1 checkpointed");
  fs.stats.set(`${HOME}/opencode.db`, { mtimeMs: 2000, size: 20 });
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded([a]),
    readParentLinks: () => linked([{ sessionId: "a", parentId: null }]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  assert.ok(
    !fs.files.has(`${ROOT}/opencode-b/main.jsonl`),
    "a deleted session's projection is still pruned when the load was complete"
  );
  assert.notEqual(
    fs.files.get(fingerprintPath),
    sweepOneFingerprint,
    "and the fingerprint advances to the new DB revision on a clean sweep"
  );
});

test("ISS-5238 F2: a dropped root's child is WITHHELD from the projection too, matching the collector", () => {
  const fs = fakeFs(dbStats(1000, 10));
  // `root` itself is deliberately absent from the load — that is what "dropped"
  // means here — but the linkage read still sees every `session` row, so the
  // child's parent is known.
  const child = makeSession({
    sessionId: "opencode-child",
    entrypoint: "opencode",
  });
  const other = makeSession({
    sessionId: "opencode-other",
    entrypoint: "opencode",
  });
  const links = [
    { sessionId: "root", parentId: null },
    { sessionId: "child", parentId: "root" },
    { sessionId: "other", parentId: null },
  ];
  const logs: string[] = [];
  // The ROOT row failed to parse; its child parsed fine. The collector withholds
  // that child from the desktop corpus, so publishing it here would archive a
  // subagent under `opencode-root`, whose `main.jsonl` will never exist — turns
  // attributed to a session the desktop has no record of.
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () =>
      partiallyLoaded(
        [child, other],
        [{ sessionId: "root", reason: "Invalid token count for x" }]
      ),
    readParentLinks: () => linked(links),
    openCodeHome: () => HOME,
    fsImpl: fs,
    log: (message) => logs.push(message),
  });
  assert.ok(
    !fs.files.has(`${ROOT}/opencode-root/subagent:child.jsonl`),
    "the child is not published under a root that has no record"
  );
  assert.ok(
    !fs.files.has(`${ROOT}/opencode-root/main.jsonl`),
    "and the dropped root itself was never written"
  );
  assert.ok(
    logs.some(
      (message) =>
        message.includes("opencode materialize withheld") &&
        message.includes("opencode-child")
    ),
    "the withhold is reported on the monitored channel rather than silently skipped"
  );
  assert.ok(
    fs.files.has(`${ROOT}/opencode-other/main.jsonl`),
    "an unrelated healthy session still publishes"
  );
  // The withhold is deliberate, not a write failure: withholding the checkpoint
  // as well would re-parse the whole DB on every sweep for as long as that row
  // exists, which is the trap the prune scoping avoids.
  assert.ok(
    fs.files.get(opencodeMaterializerFingerprintPath(STATE_DIR)),
    "and the checkpoint still advances"
  );
});

test("ISS-5238 F3: a lossy load still prunes ANOTHER session's reparented old key", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const dropped = makeSession({
    sessionId: "opencode-dropped",
    entrypoint: "opencode",
  });
  const root = makeSession({
    sessionId: "opencode-root",
    entrypoint: "opencode",
  });
  const child = makeSession({
    sessionId: "opencode-child",
    entrypoint: "opencode",
  });
  // Sweep 1: all three parse, and `child` is its own top-level root.
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded([dropped, root, child]),
    readParentLinks: () =>
      linked([
        { sessionId: "dropped", parentId: null },
        { sessionId: "root", parentId: null },
        { sessionId: "child", parentId: null },
      ]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  const droppedProjection = `${ROOT}/opencode-dropped/main.jsonl`;
  const droppedBody = fs.files.get(droppedProjection);
  assert.ok(droppedBody, "sweep 1 published the soon-to-be-dropped session");
  assert.ok(
    fs.files.has(`${ROOT}/opencode-child/main.jsonl`),
    "sweep 1 filed child as its own top-level root"
  );

  // Sweep 2: `dropped` no longer parses AND `child` is reparented under `root`.
  // A dropped row is durable, so a store-wide prune SKIP would not defer the
  // cleanup for one sweep — it would disable it for as long as that row exists,
  // while the checkpoint still advances. `child` would then keep archiving under
  // BOTH identities forever. The skip must be scoped to `dropped`'s own files.
  fs.stats.set(`${HOME}/opencode.db`, { mtimeMs: 2000, size: 20 });
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () =>
      partiallyLoaded(
        [root, child],
        [{ sessionId: "dropped", reason: "Invalid token count for x" }]
      ),
    readParentLinks: () =>
      linked([
        { sessionId: "dropped", parentId: null },
        { sessionId: "root", parentId: null },
        { sessionId: "child", parentId: "root" },
      ]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  assert.ok(
    fs.files.has(`${ROOT}/opencode-root/subagent:child.jsonl`),
    "child publishes under its new root"
  );
  assert.ok(
    !fs.files.has(`${ROOT}/opencode-child/main.jsonl`),
    "child's OLD top-level key is pruned even though the load was lossy — otherwise one bad row leaves it archiving under two identities"
  );
  assert.equal(
    fs.files.get(droppedProjection),
    droppedBody,
    "and the dropped session's own projection is still untouched"
  );
});

test("ISS-5337: siblings and a deep chain all file under the ONE true root", () => {
  const fs = fakeFs(dbStats(1000, 10));
  // grandchild -> child -> root, plus a sibling of `child` under the same root.
  const sessions = ["root", "child", "sibling", "grandchild"].map((id) =>
    makeSession({ sessionId: `opencode-${id}`, entrypoint: "opencode" })
  );
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded(sessions),
    readParentLinks: () =>
      linked([
        { sessionId: "root", parentId: null },
        { sessionId: "child", parentId: "root" },
        { sessionId: "sibling", parentId: "root" },
        { sessionId: "grandchild", parentId: "child" },
      ]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });

  // Every descendant archives under the root's identity — the memoized walk must
  // not short-circuit a sibling or a deeper chain to an intermediate parent.
  assert.deepEqual(
    [...fs.files.keys()].filter((p) => p.startsWith(ROOT)).sort(),
    [
      `${ROOT}/opencode-root/main.jsonl`,
      `${ROOT}/opencode-root/subagent:child.jsonl`,
      `${ROOT}/opencode-root/subagent:grandchild.jsonl`,
      `${ROOT}/opencode-root/subagent:sibling.jsonl`,
    ]
  );
});

test("ISS-5337: a cyclic linkage still resolves without looping or throwing", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const sessions = ["a", "b"].map((id) =>
    makeSession({ sessionId: `opencode-${id}`, entrypoint: "opencode" })
  );
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded(sessions),
    readParentLinks: () =>
      linked([
        { sessionId: "a", parentId: "b" },
        { sessionId: "b", parentId: "a" },
      ]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });

  // Both cycle members are children, so both file as subagents under the ONE id
  // the cycle resolves to — the lexicographically smallest member.
  const written = [...fs.files.keys()].filter((p) => p.startsWith(ROOT)).sort();
  assert.deepEqual(written, [
    `${ROOT}/opencode-a/subagent:a.jsonl`,
    `${ROOT}/opencode-a/subagent:b.jsonl`,
  ]);
});

test("ISS-5337 (review): a cycle files identically however the caller orders its sessions", () => {
  // The materializer seeds `rootCache` from its write pass over `load.sessions`
  // and the collector seeds it from its folded-root classification pass, and the
  // shared module cannot force those two loops to agree on an order. So the
  // answer for a cycle has to be a function of the LINKAGE alone: walk the same
  // `a ↔ b` from the other end and the archive layout must not move.
  const layouts = [
    ["a", "b"],
    ["b", "a"],
  ].map((order) => {
    const fs = fakeFs(dbStats(1000, 10));
    materializeOpencodeTranscripts(STATE_DIR, {
      loadSessions: () =>
        loaded(
          order.map((id) =>
            makeSession({ sessionId: `opencode-${id}`, entrypoint: "opencode" })
          )
        ),
      readParentLinks: () =>
        linked([
          { sessionId: "a", parentId: "b" },
          { sessionId: "b", parentId: "a" },
        ]),
      openCodeHome: () => HOME,
      fsImpl: fs,
    });
    return [...fs.files.keys()].filter((p) => p.startsWith(ROOT)).sort();
  });

  assert.deepEqual(
    layouts[0],
    layouts[1],
    "the same opencode.db nested one way locally and another way in the archive"
  );
});

test("ISS-5337: the prune reaps a publish temp abandoned by a killed pass", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const session = makeSession({
    sessionId: "opencode-abc",
    entrypoint: "opencode",
  });
  // A temp stamped with a pid that is not this process: only a pass that no
  // longer exists could have written it (a timed-out or stopped worker).
  const orphan = `${ROOT}/opencode-abc/.main.jsonl.${process.pid + 1}.1700000000000.tmp`;
  const mine = `${ROOT}/opencode-abc/.main.jsonl.${process.pid}.1700000000001.tmp`;
  fs.files.set(orphan, "half-written");
  fs.files.set(mine, "in flight");

  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded([session]),
    readParentLinks: () => linked([{ sessionId: "abc", parentId: null }]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });

  assert.equal(fs.files.has(orphan), false, "abandoned temp reaped");
  assert.equal(fs.files.has(mine), true, "this pass's own temp untouched");
  assert.ok(fs.files.has(`${ROOT}/opencode-abc/main.jsonl`));
  // The reap does not withhold the checkpoint.
  assert.ok(fs.files.has(opencodeMaterializerFingerprintPath(STATE_DIR)));
});
