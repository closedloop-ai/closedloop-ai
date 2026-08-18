/**
 * @file opencode-materializer-torn-pass.test.ts
 * @description ISS-5337 (review): the materialize pass now runs inside a
 * utilityProcess that a timeout or `stop()` can kill at any instruction, so the
 * pass has to be safe to CUT ANYWHERE rather than merely safe to complete.
 *
 * These pin the two consequences of that:
 *  - the prune must precede the writes, so a reparented child is never on disk
 *    under BOTH its old and its new `(externalSessionId, fileKey)` — nothing
 *    downstream filters that duplicate (`listOpencodeMaterializedFiles` has no
 *    expected-set, and the sweep swallows a materialize rejection and walks
 *    straight into `discover()`), so a cut in the old order double-published the
 *    same turns and tokens under two external session ids;
 *  - the projection revision must invalidate an existing checkpoint whenever a
 *    re-file is what the upgrade delivers, since the fingerprint gate is the
 *    only thing that would otherwise re-derive an untouched `opencode.db`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  materializeOpencodeTranscripts,
  opencodeMaterializerFingerprintPath,
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

/** The `rev:<n>|` component the checkpoint fingerprint leads with. */
const PROJECTION_REVISION_PREFIX_RE = /^rev:\d+\|/;

/** Published projections only — `.tmp` publish files are in-flight, not visible. */
const PROJECTION_FILE_RE = /\.jsonl$/;

test("ISS-5337: a reparented child is never on disk under BOTH roots, at any instant of the pass", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const parents = ["alpha", "beta"].map((id) =>
    makeSession({ sessionId: `opencode-${id}`, entrypoint: "opencode" })
  );
  const child = makeSession({
    sessionId: "opencode-kid",
    entrypoint: "opencode",
  });
  const sessions = [...parents, child];

  // Sweep 1: `kid` belongs to `alpha`.
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded(sessions),
    readParentLinks: () =>
      linked([
        { sessionId: "alpha", parentId: null },
        { sessionId: "beta", parentId: null },
        { sessionId: "kid", parentId: "alpha" },
      ]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });
  const oldPath = `${ROOT}/opencode-alpha/subagent:kid.jsonl`;
  const newPath = `${ROOT}/opencode-beta/subagent:kid.jsonl`;
  assert.ok(fs.files.has(oldPath), "sweep 1 filed the child under alpha");

  // Sweep 2: the DB changed and `kid` now belongs to `beta`. Snapshot the
  // published set after EVERY mutation, so a kill landing at any of them is
  // represented — the utilityProcess host makes every one of these instants
  // reachable.
  fs.stats.set(`${HOME}/opencode.db`, { mtimeMs: 2000, size: 11 });
  const snapshots = recordProjectionSnapshots(fs);
  materializeOpencodeTranscripts(STATE_DIR, {
    loadSessions: () => loaded(sessions),
    readParentLinks: () =>
      linked([
        { sessionId: "alpha", parentId: null },
        { sessionId: "beta", parentId: null },
        { sessionId: "kid", parentId: "beta" },
      ]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  });

  assert.ok(fs.files.has(newPath), "sweep 2 filed the child under beta");
  assert.equal(fs.files.has(oldPath), false, "and dropped the alpha copy");
  const torn = snapshots.findIndex(
    (published) => published.has(oldPath) && published.has(newPath)
  );
  assert.equal(
    torn,
    -1,
    `the child was published under both roots at snapshot ${torn} — a pass cut there double-publishes it`
  );
});

test("ISS-5337: a checkpoint from the pre-re-root revision does not gate the re-file", () => {
  const fs = fakeFs(dbStats(1000, 10));
  const session = makeSession({
    sessionId: "opencode-abc",
    entrypoint: "opencode",
  });
  let loadCount = 0;
  const deps = {
    loadSessions: () => {
      loadCount += 1;
      return loaded([session]);
    },
    readParentLinks: () => linked([{ sessionId: "abc", parentId: null }]),
    openCodeHome: () => HOME,
    fsImpl: fs,
  };

  materializeOpencodeTranscripts(STATE_DIR, deps);
  assert.equal(loadCount, 1);
  const fingerprintPath = opencodeMaterializerFingerprintPath(STATE_DIR);
  const current = fs.files.get(fingerprintPath);
  assert.ok(current, "sweep 1 wrote a checkpoint");

  // The checkpoint a build predating the cycle re-root wrote for this very same
  // untouched store. The re-root moves WHERE such a store's children are filed
  // without changing a byte of their bodies, so only the revision can force the
  // one re-derive that converges the archive with the collector's fold.
  fs.files.set(
    fingerprintPath,
    current.replace(PROJECTION_REVISION_PREFIX_RE, "rev:1|")
  );

  materializeOpencodeTranscripts(STATE_DIR, deps);
  assert.equal(
    loadCount,
    2,
    "the pre-re-root checkpoint must not short-circuit the upgrade's one re-derive"
  );
  assert.equal(
    fs.files.get(fingerprintPath),
    current,
    "and the checkpoint is rewritten at the current projection revision"
  );
});

/**
 * Snapshot the set of PUBLISHED projections after every mutating `fsImpl` call,
 * so an assertion can quantify over "the state a kill would leave behind" rather
 * than over the final state only.
 */
function recordProjectionSnapshots(fs: FakeFs): Set<string>[] {
  const snapshots: Set<string>[] = [];
  const capture = (): void => {
    snapshots.push(
      new Set(
        [...fs.files.keys()].filter(
          (filePath) =>
            filePath.startsWith(ROOT) && PROJECTION_FILE_RE.test(filePath)
        )
      )
    );
  };
  const { writeFileSync, renameSync, rmSync } = fs;
  fs.writeFileSync = (p, data) => {
    writeFileSync(p, data);
    capture();
  };
  fs.renameSync = (from, to) => {
    renameSync(from, to);
    capture();
  };
  fs.rmSync = (p, opts) => {
    rmSync(p, opts);
    capture();
  };
  return snapshots;
}
