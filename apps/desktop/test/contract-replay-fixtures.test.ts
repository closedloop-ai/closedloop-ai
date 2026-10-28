/**
 * @file contract-replay-fixtures.test.ts
 * @description ISS-9846 (PRD-707 R1) — THE STALENESS GATE for the adversarial
 * desktop→cloud contract fixtures the API realdb replay suite reads.
 *
 * The API side cannot run the desktop payload builders: `apps/desktop` is
 * `private: true`, exports nothing, and is not a declared dependency of
 * `apps/api`. So the fixtures under
 * `apps/api/__tests__/fixtures/desktop-contract-replay/` are a RECORDING, and a
 * recording of a builder's output is a test of the recording — it stays green
 * forever while the builder drifts away from it. That is precisely the
 * false-green class this layer exists to catch.
 *
 * This suite closes it, on the only side of the boundary that can: it rebuilds
 * every fixture through the same production builders and compares the bytes. A
 * change to `src/main/agent-sync/agent-session-sync-payload.ts` or
 * `agent-component-invocation-sync-payload.ts` that alters any emitted payload
 * reds here until the fixtures are regenerated.
 *
 * Regenerate with:
 *   CONTRACT_REPLAY_WRITE_FIXTURES=1 pnpm --filter desktop exec vitest run \
 *     --config vitest.node.config.ts test/contract-replay-fixtures.test.ts
 *
 * Then rerun WITHOUT the variable. That second run is the check, not a
 * courtesy: it rebuilds the same bytes and compares them to what was just
 * committed.
 *
 * No database, no Electron, no fixture directory of its own — so unlike the
 * `describeIfDb` parity suites it cannot skip into a false green.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
  buildContractReplayFixtures,
  CONTRACT_REPLAY_FIXTURES_DIR,
  CONTRACT_REPLAY_MANIFEST_FILE,
  CONTRACT_REPLAY_REGEN_COMMAND,
} from "./contract-replay/fixtures-build.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES_DIR = resolve(REPO_ROOT, CONTRACT_REPLAY_FIXTURES_DIR);
const WRITE_MODE = process.env.CONTRACT_REPLAY_WRITE_FIXTURES === "1";

function committed(name: string): string | null {
  try {
    return readFileSync(join(FIXTURES_DIR, name), "utf8");
  } catch {
    return null;
  }
}

describe("desktop contract-replay fixtures (ISS-9846)", () => {
  test("the committed fixtures are what the production builders emit today", () => {
    const built = buildContractReplayFixtures();
    // A build that produced nothing would let every comparison below pass
    // vacuously, so pin that the seed set is non-empty before comparing.
    assert.ok(built.files.length > 1, "expected fixtures plus a manifest");

    if (WRITE_MODE) {
      mkdirSync(FIXTURES_DIR, { recursive: true });
      for (const file of built.files) {
        writeFileSync(join(FIXTURES_DIR, file.name), file.contents, "utf8");
      }
      process.stdout.write(
        `[contract-replay] wrote ${built.files.length} file(s) to ${CONTRACT_REPLAY_FIXTURES_DIR}\n`
      );
      return;
    }

    for (const file of built.files) {
      const onDisk = committed(file.name);
      assert.notEqual(
        onDisk,
        null,
        `${file.name} is missing from ${CONTRACT_REPLAY_FIXTURES_DIR}. Regenerate: ${CONTRACT_REPLAY_REGEN_COMMAND}`
      );
      assert.equal(
        onDisk,
        file.contents,
        `${file.name} is STALE — the desktop payload builder no longer emits these bytes. Regenerate: ${CONTRACT_REPLAY_REGEN_COMMAND}`
      );
    }
  });

  test("no orphaned fixture outlives the seed that produced it", () => {
    if (WRITE_MODE) {
      return;
    }
    const built = buildContractReplayFixtures();
    const expected = new Set(built.files.map((file) => file.name));
    const onDisk = readdirSync(FIXTURES_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();
    assert.deepEqual(
      onDisk.filter((name) => !expected.has(name)),
      [],
      `orphaned fixture(s) — a seed was removed without deleting its file. Regenerate: ${CONTRACT_REPLAY_REGEN_COMMAND}`
    );
    // The manifest is the API suite's entry point; a directory without it is a
    // publication that half-happened.
    assert.ok(onDisk.includes(CONTRACT_REPLAY_MANIFEST_FILE));
  });
});
