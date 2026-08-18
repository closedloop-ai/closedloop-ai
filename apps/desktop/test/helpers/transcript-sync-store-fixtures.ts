/**
 * @file transcript-sync-store-fixtures.ts
 * @description Shared fixtures for the FEA-2715 transcript-sync STORE suites:
 * the canonical observe input, the fixed clock string, and the
 * open-store-then-close harness that runs each case against a real libSQL
 * database (the production migration runner).
 *
 * ISS-4815: extracted when `transcript-sync-store.test.ts` was split into the
 * store-behavior suite plus `transcript-sync-store-recovery.test.ts` (the
 * re-arm / revive / redrive cluster), so both own one copy of the harness
 * instead of redeclaring it — mirroring the #4195 executor-fixtures split.
 */
import type { TranscriptObserveInput } from "../../src/main/database/transcript-sync-store.js";
import {
  createTranscriptSyncStore,
  type TranscriptSyncStore,
} from "../../src/main/database/transcript-sync-store.js";
import { openTestPrisma } from "../prisma-test-utils.js";

export const T0 = "2026-07-09T00:00:00.000Z";

export function observeInput(
  overrides: Partial<TranscriptObserveInput> = {}
): TranscriptObserveInput {
  return {
    externalSessionId: "sess-1",
    fileKey: "main",
    sourceHarness: "claude",
    sourcePath: "/home/.claude/projects/p/sess-1.jsonl",
    sourcePathHash: "hash-1",
    mtimeMs: 1000,
    size: 500,
    syncClass: "backfill",
    now: T0,
    ...overrides,
  };
}

export async function withStore(
  run: (store: TranscriptSyncStore) => Promise<void>
): Promise<void> {
  const { prisma, close } = await openTestPrisma();
  try {
    await run(createTranscriptSyncStore(prisma));
  } finally {
    await close();
  }
}
