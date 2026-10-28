/**
 * @file ingest-pending-bytes-wiring.test.ts
 * @description ISS-8346 — the byte remainder driven through the REAL
 * `CollectorManager` import loop.
 *
 * `ingest-pending-bytes.test.ts` pins the ledger's rules against a bare tracker.
 * This file pins the wiring those rules are useless without: that the scan
 * actually sizes the pending set, that the loop subtracts each source's own
 * bytes as it lands, and that a population nothing could size is refused rather
 * than reported as an empty remainder. Delete the `measurePendingSourceBytes`
 * call from the scan and every case here fails; the unit suite stays green.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import { measurePendingSourceBytes } from "../src/main/collectors/engine/collector-pending-sources.js";
import {
  makeSession,
  noopCooperativeDelay,
} from "./helpers/collector-manager-fixtures.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

afterEach(() => {
  nodeTestTimers.reset();
});

const SOURCE_COUNT = 3;
/** Every source the same size, so the expected samples do not depend on order. */
const SOURCE_BODY = "x".repeat(4096);
const SOURCE_BYTES = SOURCE_BODY.length;
const CODEX = ["codex"];

/**
 * Drive one boot import over `sources`, sampling the remainder at each import.
 *
 * The sample is taken INSIDE `importSession`, which runs before the loop
 * completes that source — so the first sample is the whole pass and the last is
 * one source's worth short of empty.
 */
async function runPass(
  dir: string,
  sources: string[]
): Promise<{ samples: (number | null)[]; final: number | null }> {
  nodeTestTimers.enable(["setTimeout"]);
  const samples: (number | null)[] = [];
  let resolveBootComplete: (() => void) | undefined;
  const bootComplete = new Promise<void>((resolve) => {
    resolveBootComplete = resolve;
  });
  const manager = new CollectorManager({
    importer: {
      importSession: () => {
        samples.push(manager.remainingPendingBytes(CODEX));
        return Promise.resolve({ skipped: false, reactivated: false });
      },
    },
    stateDir: dir,
    emit: () => {
      // The dashboard event sink; this suite reads the manager directly.
    },
    getCollectionMode: () => "watcher",
    cooperativeDelay: noopCooperativeDelay,
    historicalImportDelayMs: 25,
    catchupPollMs: null,
    log: () => {
      // Console observability has its own suite.
    },
    onBootImportComplete: () => resolveBootComplete?.(),
    collectors: [
      {
        key: "codex",
        cacheName: "codex",
        allowUnscopedSourceAdmission: true,
        watchRoots: () => [],
        watchMatch: () => true,
        listSources: () => sources,
        parse: async (source) => [makeSession(`session-${source}`)],
      },
    ],
  });

  manager.start();
  await new Promise((resolve) => setImmediate(resolve));
  nodeTestTimers.tick(25);
  await bootComplete;
  const final = manager.remainingPendingBytes(CODEX);
  await manager.stop();
  return { final, samples };
}

test("the import loop drains the remainder by each landed source's own bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ingest-pending-bytes-wiring-"));
  try {
    const sources: string[] = [];
    for (let index = 0; index < SOURCE_COUNT; index += 1) {
      const source = join(dir, `codex-${index}.jsonl`);
      writeFileSync(source, SOURCE_BODY);
      sources.push(source);
    }

    const { samples, final } = await runPass(dir, sources);

    assert.deepEqual(
      samples,
      [SOURCE_BYTES * 3, SOURCE_BYTES * 2, SOURCE_BYTES],
      "the pass opens at the summed pending bytes and falls one source at a time"
    );
    assert.equal(
      final,
      0,
      "a pass whose every source landed has nothing left to parse"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pending population nothing could size states no remainder at all", async () => {
  // Reachable, not contrived: a source enumerated and then deleted before the
  // scan reads it has no stat on either pass. Reporting 0 here would tell the
  // onboarding estimate the corpus is parsed while the import is still running,
  // and its high-water mark would hold that for the life of the process.
  const dir = mkdtempSync(join(tmpdir(), "ingest-pending-bytes-missing-"));
  try {
    const sources = [join(dir, "gone-0.jsonl"), join(dir, "gone-1.jsonl")];

    const { samples, final } = await runPass(dir, sources);

    assert.deepEqual(samples, [null, null]);
    assert.equal(final, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source with no stat is sized by the fallback the scan pays for it", async () => {
  // The batch-collector case, where `collectPendingSources` reads no stat at
  // all: without this fallback an OpenCode pass would be permanently unmeasured
  // and would withdraw the estimate for every harness beside it.
  const dir = mkdtempSync(join(tmpdir(), "ingest-pending-bytes-measure-"));
  try {
    const sized = join(dir, "sized.jsonl");
    const unstatted = join(dir, "unstatted.jsonl");
    writeFileSync(sized, SOURCE_BODY);
    writeFileSync(unstatted, SOURCE_BODY);

    const measured = await measurePendingSourceBytes([
      { source: sized, stat: statSync(sized), extraMtime: null },
      { source: unstatted, stat: null, extraMtime: null },
    ]);

    assert.equal(measured.totalBytes, SOURCE_BYTES * 2);
    assert.equal(measured.bytesBySource.get(unstatted), SOURCE_BYTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partially sizable population reports the part it could measure", async () => {
  // One vanished file must not withdraw the whole number. It contributes to
  // neither the total nor any later subtraction, so the pair stays consistent
  // and the only cost is that progress reads ahead by that file's bytes.
  const dir = mkdtempSync(join(tmpdir(), "ingest-pending-bytes-partial-"));
  try {
    const present = join(dir, "present.jsonl");
    writeFileSync(present, SOURCE_BODY);

    const measured = await measurePendingSourceBytes([
      { source: present, stat: null, extraMtime: null },
      { source: join(dir, "missing.jsonl"), stat: null, extraMtime: null },
    ]);

    assert.equal(measured.totalBytes, SOURCE_BYTES);
    assert.equal(measured.bytesBySource.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty pending set is a real zero, not an unmeasured population", async () => {
  const measured = await measurePendingSourceBytes([]);

  assert.equal(measured.totalBytes, 0);
  assert.equal(measured.bytesBySource.size, 0);
});
