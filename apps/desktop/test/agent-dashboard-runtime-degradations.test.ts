/**
 * @file agent-dashboard-runtime-degradations.test.ts
 * @description ISS-8143 — the composition-root degradations, executed.
 *
 * Before the extraction these were inline closures inside
 * `registerDesktopIpcHandlers`, which needs the whole Electron boot graph, so
 * no node test could run them. Each carried a comment ASSERTING its degradation
 * and nothing checked it.
 *
 * The absence cases are the obvious half. The half that actually matters is
 * `re-reads its source on every call`: a builder that reads the runtime ONCE at
 * construction and returns the captured value thereafter type-checks, passes
 * every absence-only case, and ships an install whose Settings panel reports
 * "no collectors" for the life of the process — because the runtime is null
 * until the collectors exist, which is exactly when this wiring is built. So
 * each source below is flipped BETWEEN calls on ONE built object.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { AgentDashboardDesignSystemRuntime } from "../src/main/dashboard/agent-dashboard-design-system-runtime.js";
import {
  buildAgentDashboardRuntimeProgressGetters,
  buildOnboardingParseProgressReader,
  buildTranscriptForceSyncOversized,
} from "../src/main/ipc/agent-dashboard-runtime-degradations.js";
import { PARSE_PROGRESS_UNMEASURED } from "../src/main/onboarding/onboarding-parse-progress.js";
import type { TranscriptSyncService } from "../src/main/transcript-sync/transcript-sync-service.js";
import { AnalysisParserActivity } from "../src/shared/transcript-analysis-eta-contract.js";

const INGEST = { imported: 3, total: 10 };
const MAINTENANCE = { phase: "vacuum" };
/** A second, distinct runtime — the FEA-3907-style in-place rebuild. */
const SECOND_INGEST = { imported: 9, total: 10 };
const BLOCKS = [{ path: "/tmp/blocked.jsonl", reason: "eperm" }];

function fakeRuntime(): AgentDashboardDesignSystemRuntime {
  return {
    getIngestProgress: () => INGEST,
    getFileAccessBlocks: () => BLOCKS,
    getMaintenanceProgress: () => MAINTENANCE,
  } as unknown as AgentDashboardDesignSystemRuntime;
}

describe("ISS-8143 — the runtime-info getters degrade when the runtime is absent", () => {
  test("an absent runtime yields null / [] / null, not a throw", () => {
    // FEA-3639: `[]` for the blocks because no collectors means none were hit —
    // a true empty. `null` for the two progress reports because "not started"
    // is unknown, not zero. A getter that answered `0`/`{}` here would let the
    // renderer present a boot state as a measurement.
    const getters = buildAgentDashboardRuntimeProgressGetters(() => null);

    assert.equal(getters.getIngestProgress(), null);
    assert.deepEqual(getters.getFileAccessBlocks(), []);
    assert.equal(getters.getMaintenanceProgress(), null);
  });

  test("a live runtime is forwarded verbatim", () => {
    const getters = buildAgentDashboardRuntimeProgressGetters(fakeRuntime);

    assert.equal(getters.getIngestProgress(), INGEST);
    assert.equal(getters.getFileAccessBlocks(), BLOCKS);
    assert.equal(getters.getMaintenanceProgress(), MAINTENANCE);
  });

  test("the runtime is re-read on EVERY call, never captured at build time", () => {
    // The load-bearing case. The runtime does not exist when this wiring is
    // built, so a builder that captured `getRuntime()` once would answer the
    // degraded value forever — and every absence-only assertion above would
    // still pass.
    let runtime: AgentDashboardDesignSystemRuntime | null = null;
    const getters = buildAgentDashboardRuntimeProgressGetters(() => runtime);

    assert.equal(getters.getIngestProgress(), null);
    assert.deepEqual(getters.getFileAccessBlocks(), []);

    runtime = fakeRuntime();

    assert.equal(
      getters.getIngestProgress(),
      INGEST,
      "the SAME getter must see a runtime that came up after it was built"
    );
    assert.equal(getters.getFileAccessBlocks(), BLOCKS);
    assert.equal(getters.getMaintenanceProgress(), MAINTENANCE);

    // And back: a runtime torn down mid-process degrades again rather than
    // serving the last value it saw. This is the half that kills a
    // `cached ??= getRuntime()` mutation, which survives null→live alone.
    runtime = null;

    assert.equal(getters.getIngestProgress(), null);
    assert.deepEqual(getters.getFileAccessBlocks(), []);
  });

  test("a REPLACED runtime is followed, not the first live one seen", () => {
    // The remaining mutation: a builder that caches the first NON-null runtime
    // passes both cases above. The Agent Dashboard runtime is rebuilt in place,
    // so a cached reference would keep reporting the retired instance's
    // progress while the live one moves.
    const second = {
      getIngestProgress: () => SECOND_INGEST,
    } as unknown as AgentDashboardDesignSystemRuntime;
    let runtime: AgentDashboardDesignSystemRuntime | null = fakeRuntime();
    const getters = buildAgentDashboardRuntimeProgressGetters(() => runtime);

    assert.equal(getters.getIngestProgress(), INGEST);

    runtime = second;

    assert.equal(
      getters.getIngestProgress(),
      SECOND_INGEST,
      "the getter must follow a rebuilt runtime, not the one it first saw"
    );
  });
});

describe("ISS-8143 — force-archive degrades when the transcript lane is absent", () => {
  test("a null lane resolves an unavailable result rather than throwing", async () => {
    // The metadata data-sync level persists `transcriptSyncEnabled` false, so
    // this is the COMMON case, not an edge: every metadata-tier machine takes
    // it. A throw here would cross `ipcMain.handle` as a rejected invoke.
    const forceSyncOversized = buildTranscriptForceSyncOversized(() => null);

    assert.deepEqual(await forceSyncOversized("session-1", "file-1"), {
      kind: "unavailable",
    });
  });

  test("a live lane receives both arguments and its result is returned", async () => {
    const calls: [string, string][] = [];
    const lane = {
      forceSyncOversized: (externalSessionId: string, fileKey: string) => {
        calls.push([externalSessionId, fileKey]);
        return Promise.resolve({ kind: "queued" as const });
      },
    } as unknown as TranscriptSyncService;

    const forceSyncOversized = buildTranscriptForceSyncOversized(() => lane);
    const result = await forceSyncOversized("session-1", "file-1");

    assert.deepEqual(calls, [["session-1", "file-1"]]);
    assert.deepEqual(result, { kind: "queued" });
  });

  test("the lane is re-read on EVERY call, never captured at build time", async () => {
    // FEA-3907: a privacy-tier change REBUILDS the transcript-sync service. A
    // captured reference would keep driving the retired lane — the uploads
    // would go to a service nothing else is talking to any more.
    let lane: TranscriptSyncService | null = null;
    const forceSyncOversized = buildTranscriptForceSyncOversized(() => lane);

    assert.deepEqual(await forceSyncOversized("session-1", "file-1"), {
      kind: "unavailable",
    });

    lane = {
      forceSyncOversized: () => Promise.resolve({ kind: "queued" as const }),
    } as unknown as TranscriptSyncService;

    assert.deepEqual(
      await forceSyncOversized("session-1", "file-1"),
      { kind: "queued" },
      "the SAME bound action must follow a lane built after it"
    );

    // The half that kills a `cached ??= getTranscriptSync()` mutation, which
    // survives null→live alone. A privacy-tier change REPLACES live lane A with
    // live lane B; a cached reference would keep uploading through the retired
    // one, which is exactly the failure the builder's comment describes.
    lane = {
      forceSyncOversized: () =>
        Promise.resolve({ kind: "unsupported" as const }),
    } as unknown as TranscriptSyncService;

    assert.deepEqual(
      await forceSyncOversized("session-1", "file-1"),
      { kind: "unsupported" },
      "the bound action must follow a REPLACED lane, not the first live one"
    );
  });
});

describe("ISS-8346 — the onboarding parse-progress reader follows the runtime", () => {
  const READING = {
    activity: AnalysisParserActivity.Running,
    remainingBytes: 4096,
  };
  const HARNESSES = ["claude", "codex"];

  test("an absent runtime states no remainder rather than a zero", () => {
    // A zero here would tell the onboarding estimate the corpus is already
    // parsed, and its high-water mark holds that for the life of the process.
    const read = buildOnboardingParseProgressReader(() => null);

    assert.deepEqual(read(HARNESSES), PARSE_PROGRESS_UNMEASURED);
  });

  test("the harnesses the caller named reach the runtime unchanged", () => {
    // The inventory never counts Cursor or Copilot, so a reader that dropped or
    // widened this argument would subtract bytes from a total that never
    // included them.
    const asked: (readonly string[])[] = [];
    const read = buildOnboardingParseProgressReader(
      () =>
        ({
          readParseProgress: (harnesses: readonly string[]) => {
            asked.push(harnesses);
            return READING;
          },
        }) as unknown as AgentDashboardDesignSystemRuntime
    );

    assert.equal(read(HARNESSES), READING);
    assert.deepEqual(asked, [HARNESSES]);
  });

  test("the runtime is re-read on EVERY call, never captured at build time", () => {
    // The load-bearing case, and worse here than for the getters above: the
    // onboarding source is constructed DURING registration, before the runtime
    // exists, so a captured null would leave the estimate with no producer at
    // all and the screen would never state a minute count on any machine.
    let runtime: AgentDashboardDesignSystemRuntime | null = null;
    const read = buildOnboardingParseProgressReader(() => runtime);

    assert.deepEqual(read(HARNESSES), PARSE_PROGRESS_UNMEASURED);

    runtime = {
      readParseProgress: () => READING,
    } as unknown as AgentDashboardDesignSystemRuntime;

    assert.equal(
      read(HARNESSES),
      READING,
      "the SAME reader must see a runtime that came up after it was built"
    );

    runtime = null;

    assert.deepEqual(read(HARNESSES), PARSE_PROGRESS_UNMEASURED);
  });
});
