/**
 * @file local-transcript-path-resolver.test.ts
 * @description Behavioral tests for the store-independent local-transcript path
 * resolver that backs the read bridge's graceful LOCAL fallback. The key
 * property under test: it resolves the on-disk path even when the transcript-
 * sync store is unavailable (sync flag OFF) or has not yet observed the file
 * (freshly-run session), by falling back to collector-root discovery.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createLocalTranscriptResolverDeps,
  createMemoizedDiscover,
  type FingerprintLookup,
  type LocalTranscriptPathResolverDeps,
  listLocalTranscriptFileKeys,
  resolveLocalTranscriptPath,
} from "../src/main/transcript-sync/local-transcript-path-resolver.js";
import { opencodeMaterializedRoot } from "../src/main/transcript-sync/opencode-materializer.js";
import type { TranscriptFileRef } from "../src/main/transcript-sync/transcript-sync-types.js";
import { deferred } from "./deferred.js";

const SESSION_ID = "sess-abc";
const STORE_PATH = "/home/me/.claude/projects/p/sess-abc.jsonl";
const DISCOVERY_PATH = "/home/me/.claude/projects/p/sess-abc-discovered.jsonl";

function ref(overrides: Partial<TranscriptFileRef> = {}): TranscriptFileRef {
  return {
    externalSessionId: SESSION_ID,
    fileKey: "main",
    sourceHarness: "claude",
    sourcePath: DISCOVERY_PATH,
    ...overrides,
  };
}

function storeReturning(sourcePath: string | null): {
  getStore: () => FingerprintLookup;
} {
  return {
    getStore: () => ({
      get: () => Promise.resolve(sourcePath === null ? null : { sourcePath }),
    }),
  };
}

test("uses the sync store when it has the fingerprint (fast path, no discovery)", async () => {
  let discovered = false;
  const result = await resolveLocalTranscriptPath(
    {
      ...storeReturning(STORE_PATH),
      discover: () => {
        discovered = true;
        return Promise.resolve([]);
      },
    },
    SESSION_ID,
    "main"
  );
  assert.equal(result, STORE_PATH);
  // The store answered, so discovery must not run.
  assert.equal(discovered, false);
});

test("falls back to discovery when the store is null (sync flag OFF)", async () => {
  const result = await resolveLocalTranscriptPath(
    {
      getStore: () => null,
      discover: () => Promise.resolve([ref()]),
    },
    SESSION_ID,
    "main"
  );
  assert.equal(result, DISCOVERY_PATH);
});

test("falls back to discovery when the store has no row yet (not-yet-synced session)", async () => {
  const result = await resolveLocalTranscriptPath(
    {
      ...storeReturning(null),
      discover: () => Promise.resolve([ref()]),
    },
    SESSION_ID,
    "main"
  );
  assert.equal(result, DISCOVERY_PATH);
});

test("falls back to discovery when the store lookup throws", async () => {
  const result = await resolveLocalTranscriptPath(
    {
      getStore: () => ({
        get: () => Promise.reject(new Error("db host down")),
      }),
      discover: () => Promise.resolve([ref()]),
    },
    SESSION_ID,
    "main"
  );
  assert.equal(result, DISCOVERY_PATH);
});

test("matches discovery on BOTH externalSessionId and fileKey", async () => {
  const result = await resolveLocalTranscriptPath(
    {
      getStore: () => null,
      discover: () =>
        Promise.resolve([
          // Same session, different file — must NOT match a `main` request.
          ref({ fileKey: "subagent:x", sourcePath: "/wrong/subagent.jsonl" }),
          // Different session, same file — must NOT match.
          ref({
            externalSessionId: "other",
            sourcePath: "/wrong/other.jsonl",
          }),
          ref({ sourcePath: DISCOVERY_PATH }),
        ]),
    },
    SESSION_ID,
    "main"
  );
  assert.equal(result, DISCOVERY_PATH);
});

test("returns null when neither the store nor discovery has the file", async () => {
  const result = await resolveLocalTranscriptPath(
    {
      ...storeReturning(null),
      discover: () => Promise.resolve([ref({ externalSessionId: "other" })]),
    },
    SESSION_ID,
    "main"
  );
  assert.equal(result, null);
});

test("returns null (never throws) when discovery itself fails", async () => {
  const result = await resolveLocalTranscriptPath(
    {
      getStore: () => null,
      discover: () => Promise.reject(new Error("collector enumeration failed")),
    },
    SESSION_ID,
    "main"
  );
  assert.equal(result, null);
});

test("createLocalTranscriptResolverDeps forwards the getStore thunk and wires a discover fn", () => {
  // The factory is the shared wiring both the read bridge (app.ts) and the
  // detail-gating resolver call, so the lazy discovery import lives in one place.
  const getStore = () => null;
  const deps = createLocalTranscriptResolverDeps(getStore);
  assert.equal(deps.getStore, getStore);
  assert.equal(typeof deps.discover, "function");
});

test("createLocalTranscriptResolverDeps discover() enumerates a materialized OpenCode projection under stateDir (FEA-3932)", async () => {
  // Write a real materialized OpenCode projection under an ISOLATED temp state
  // dir and assert the factory's `discover()` (with the stateDir threaded
  // through) returns its ref. We inspect `discover()` directly — not the full
  // resolver — so the test never enumerates the operator's real Claude/Codex
  // home; only the temp OpenCode root is asserted on. Without the stateDir the
  // default no-op enumerator (`() => []`) omits OpenCode entirely.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-resolve-"));
  const externalSessionId = "opencode-xyz";
  const dir = path.join(opencodeMaterializedRoot(stateDir), externalSessionId);
  fs.mkdirSync(dir, { recursive: true });
  const projection = path.join(dir, "main.jsonl");
  fs.writeFileSync(projection, '{"t":"session"}\n');
  try {
    const deps = createLocalTranscriptResolverDeps(() => null, stateDir);
    const refs = await deps.discover();
    const match = refs.find(
      (r) => r.externalSessionId === externalSessionId && r.fileKey === "main"
    );
    assert.equal(match?.sourcePath, projection);
    assert.equal(match?.sourceHarness, "opencode");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// ISS-4677: the desktop session detail used to probe for `main` ALONE, capping a
// desktop-local detail at one transcript file — so the shared file switcher
// (which needs more than one) never rendered and a local session's subagent
// sidechains were unreachable on desktop. These pin the enumeration that fixes
// it, and the store-first degradation that keeps the old behavior when
// discovery cannot answer.
test("enumerates every file key for the session, main first", async () => {
  const keys = await listLocalTranscriptFileKeys(
    {
      getStore: () => null,
      discover: () =>
        Promise.resolve([
          ref({ fileKey: "subagent:agent-10" }),
          ref({ fileKey: "subagent:agent-2" }),
          ref({ fileKey: "main" }),
          ref({ externalSessionId: "other-session", fileKey: "main" }),
        ]),
    },
    SESSION_ID
  );
  assert.deepEqual(keys, ["main", "subagent:agent-2", "subagent:agent-10"]);
});

test("falls back to the store-first main probe when discovery finds nothing", async () => {
  const keys = await listLocalTranscriptFileKeys(
    {
      ...storeReturning(STORE_PATH),
      discover: () => Promise.resolve([]),
    },
    SESSION_ID
  );
  assert.deepEqual(keys, ["main"]);
});

test("reports no file keys when neither the store nor discovery can answer", async () => {
  const keys = await listLocalTranscriptFileKeys(
    {
      getStore: () => null,
      discover: () => Promise.reject(new Error("collector roots unreadable")),
    },
    SESSION_ID
  );
  assert.deepEqual(keys, []);
});

// ISS-4677 (review follow-up): the enumeration sits on the session-detail IPC,
// which the renderer refetches every few seconds while a detail is open. An
// unmemoized sweep would walk the ENTIRE local corpus per poll in the main
// process, so the caller wraps `discover` and the enumeration must not sweep
// twice on the common no-main-in-discovery path.
test("enumeration does not sweep a second time when discovery has no main", async () => {
  let sweeps = 0;
  const keys = await listLocalTranscriptFileKeys(
    {
      ...storeReturning(null),
      discover: () => {
        sweeps += 1;
        return Promise.resolve([ref({ fileKey: "subagent:agent-1" })]);
      },
    },
    SESSION_ID
  );
  assert.deepEqual(keys, ["subagent:agent-1"]);
  assert.equal(sweeps, 1);
});

test("memoized discover reuses one sweep inside the TTL and refreshes after it", async () => {
  let sweeps = 0;
  let clock = 1000;
  const discover = createMemoizedDiscover(
    () => {
      sweeps += 1;
      return Promise.resolve([ref()]);
    },
    { ttlMs: 30_000, now: () => clock }
  );

  await discover();
  await discover();
  assert.equal(sweeps, 1);

  clock += 30_000;
  await discover();
  assert.equal(sweeps, 2);
});

test("memoized discover collapses concurrent callers onto one in-flight sweep", async () => {
  let sweeps = 0;
  const gate = deferred();
  const discover = createMemoizedDiscover(() => {
    sweeps += 1;
    return gate.promise.then(() => [ref()]);
  });

  const both = Promise.all([discover(), discover()]);
  gate.resolve();
  await both;
  assert.equal(sweeps, 1);
});

// A failed sweep must not be cached, or one transient FS error would blind the
// availability gate for the whole TTL window.
test("memoized discover does not cache a failed sweep", async () => {
  let sweeps = 0;
  const discover = createMemoizedDiscover(() => {
    sweeps += 1;
    return sweeps === 1
      ? Promise.reject(new Error("collector roots unreadable"))
      : Promise.resolve([ref()]);
  });

  await assert.rejects(() => discover());
  assert.deepEqual([...(await discover())], [ref()]);
  assert.equal(sweeps, 2);
});

/**
 * ISS-5762 — the DESKTOP half of "show all subagent transcripts".
 *
 * The shared reconciliation module (`packages/app/agents/lib/subagent-transcripts.ts`)
 * documents its completeness claim for BOTH producers by name: the cloud read in
 * `apps/api/app/agent-sessions/service.ts` and the desktop-local enumeration
 * behind `resolveLocalTranscriptSummaries`. The cloud lane is pinned by the
 * "subagent transcripts are never bounded" suite in that service's tests; these
 * are the desktop lane, so the documented promise is not carrying a test on only
 * one surface.
 *
 * `listLocalTranscriptFileKeys` is the right target rather than
 * `resolveLocalTranscriptSummaries` itself: it is where the desktop POPULATION
 * is actually assembled (the summary function is a 1:1 `.map` over whatever this
 * returns), it already owns this file, and its injectable deps make it testable
 * without a filesystem, an Electron harness, or a db host.
 *
 * The fixture is sized ABOVE every row cap in the tree a future edit would
 * plausibly reuse. A fixture that fits under the cap passes today while the bug
 * is live, which is exactly how ISS-5520 and ISS-5521 survived review.
 */
const SIDECHAIN_COUNT = 122;
const OTHER_SESSION_ID = "some-other-session";

/**
 * One main plus {@link SIDECHAIN_COUNT} sidechains for the session under test,
 * interleaved with a second session's files so a cap cannot be mistaken for the
 * cross-session filter doing its job.
 */
function largeCorpusRefs(): TranscriptFileRef[] {
  const refs: TranscriptFileRef[] = [ref()];
  for (let index = 1; index <= SIDECHAIN_COUNT; index++) {
    refs.push(ref({ fileKey: `subagent:agent-${index}` }));
    refs.push(
      ref({
        externalSessionId: OTHER_SESSION_ID,
        fileKey: `subagent:other-${index}`,
      })
    );
  }
  return refs;
}

function discovering(
  refs: readonly TranscriptFileRef[]
): LocalTranscriptPathResolverDeps {
  return { getStore: () => null, discover: () => Promise.resolve([...refs]) };
}

test("enumerates every local sidechain a session owns, however large (ISS-5762)", async () => {
  const fileKeys = await listLocalTranscriptFileKeys(
    discovering(largeCorpusRefs()),
    SESSION_ID
  );

  assert.equal(fileKeys.length, SIDECHAIN_COUNT + 1);
  assert.equal(
    fileKeys.filter((fileKey) => fileKey.startsWith("subagent:")).length,
    SIDECHAIN_COUNT
  );
  // Both ends, so a prefix-shaped OR suffix-shaped cap is caught rather than
  // only one of them.
  assert.ok(fileKeys.includes("main"));
  assert.ok(fileKeys.includes("subagent:agent-1"));
  assert.ok(fileKeys.includes(`subagent:agent-${SIDECHAIN_COUNT}`));
});

test("counts only the requested session, however large the corpus (ISS-5762)", async () => {
  const fileKeys = await listLocalTranscriptFileKeys(
    discovering(largeCorpusRefs()),
    SESSION_ID
  );

  // The other session contributed 122 refs to the same sweep. None may leak in
  // — a bound applied BEFORE the identity filter would both truncate this
  // session and admit the wrong one, and asserting length alone could not tell
  // those two failures apart.
  assert.equal(
    fileKeys.filter((fileKey) => fileKey.startsWith("subagent:other-")).length,
    0
  );
});
