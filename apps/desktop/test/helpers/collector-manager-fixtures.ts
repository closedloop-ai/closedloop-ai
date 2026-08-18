/**
 * @file collector-manager-fixtures.ts
 * @description Shared fixtures for `CollectorManager` tests — the Codex session
 * factory, the completion barrier, and the no-op `FSWatcher` stub.
 *
 * Extracted from `ingest-orchestrator.test.ts` so a second manager suite can use
 * them without copying (the repo rule: a nontrivial test fixture used by more
 * than one file belongs in a shared module owned by that surface). The lower
 * level `fakeCollector` / `makeSession` primitives stay in
 * `../normalized-session-test-utils.js`, which is consumed far more widely.
 */
import type { AttachedDirectoryWatcher } from "../../src/main/collectors/engine/watcher.js";
import type { NormalizedSession } from "../../src/main/collectors/types.js";
import { makeSession as baseSession } from "../normalized-session-test-utils.js";

/** A complete, importable Codex session — the manager suites' default subject. */
export function makeSession(
  sessionId: string,
  cwd = "/sandbox/project"
): NormalizedSession {
  return baseSession({
    sessionId,
    cwd,
    model: "gpt-5",
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:05:00.000Z",
    userMessages: 1,
    assistantMessages: 1,
    entrypoint: "codex",
  });
}

/**
 * Poll until `predicate` holds, THROWING when the bound is exhausted. The
 * `test:node` determinism rule (FEA-2399) prefers synchronizing on a real
 * completion signal; where the manager exposes none for a given step, this
 * bounded loop is the sanctioned fallback precisely because it fails loudly
 * instead of falling through and letting a later assertion read stale state.
 */
export async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2000) {
      throw new Error("timed out waiting for collector import");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A watch handle that RECORDS how many times production closed it (ISS-5154).
 *
 * `AttachedDirectoryWatcher` declares `close(): void`, which a no-op fake
 * satisfies — so a regression that stopped closing attached roots would leave
 * stale `fs.watch` handles firing imports into a torn-down importer with every
 * suite still green. Recording the call is what lets a test assert the teardown
 * loop actually ran.
 */
export type RecordingDirectoryWatcher = AttachedDirectoryWatcher & {
  /** How many times the watcher under test called `close()` on this handle. */
  closeCount(): number;
};

/** A watch handle that records `close()` so teardown can be asserted. */
export function recordingFsWatcher(): RecordingDirectoryWatcher {
  let closes = 0;
  const watcher: RecordingDirectoryWatcher = {
    on: () => watcher,
    close: () => {
      closes += 1;
    },
    closeCount: () => closes,
  };
  return watcher;
}

/** An inert watch handle so a test can drive the manager's watch listener directly. */
export function fakeFsWatcher(): AttachedDirectoryWatcher {
  return recordingFsWatcher();
}

/**
 * A `cooperativeDelay` that yields nothing, for CollectorManager tests that
 * drive the import loop synchronously. Canonical home for a helper that had been
 * re-declared per test file.
 */
export async function noopCooperativeDelay(): Promise<void> {
  // Intentionally empty: the import loop's yield point is a no-op under test.
}
