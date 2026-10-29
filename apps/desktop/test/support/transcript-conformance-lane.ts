/**
 * @file transcript-conformance-lane.ts
 * @description How the conformance suite DRIVES the transcript control plane.
 * That lane's Appendix A table stays in the suite, where a reviewer reads it
 * against the standard; this is only the machinery that turns one cell into an
 * observation.
 *
 * Split out under the 1,000-line ceiling (ISS-8614): the CELLS are the oracle
 * and stay transcribed beside the standard, the DRIVE is machinery.
 */

import type { TranscriptSyncPlanRequest } from "@repo/api/src/types/desktop-transcripts";
import {
  createDesktopTranscriptsClient,
  TranscriptSyncClientError,
} from "../../src/main/transcript/desktop-transcripts-client.js";
import { TranscriptDrainQueue } from "../../src/main/transcript-sync/transcript-drain-queue.js";
import {
  type Cell,
  type Observation,
  StandardClass,
} from "../helpers/sync-classification-standard.js";
import {
  fakeExecutor,
  fakeStore,
  fingerprint,
  NOW,
} from "../helpers/transcript-sync-fixtures.js";
import {
  failureResponse,
  ORIGIN,
  SESSION_ID,
  TARGET,
  TOKEN,
} from "./sync-conformance-fixtures.js";

function transcriptPlanRequest(): TranscriptSyncPlanRequest {
  return {
    computeTargetId: TARGET,
    externalSessionId: SESSION_ID,
    fileKey: "main",
    sourceHarness: "claude",
    sourcePathHash: "path-hash-1",
    planEndOffset: 100,
    sha256: "a".repeat(64),
    crc64nvme: "AAAAAAAAAAA=",
    sourceMtime: "2026-09-06T00:00:00.000Z",
  };
}

/**
 * ISS-9420: drives the REAL `TranscriptDrainQueue`, so the class comes off what
 * `recordFailure` persisted rather than off a predicate this file evaluated.
 *
 * The read is the retry budget, and only it: `recordFailure` freezes
 * `retryCount` for a lane-wide failure and advances it for a row-attributable
 * one, which is Appendix A's decision rule ("charge nothing to the item") stated
 * as a write. Reading `laneStalledSince` as well would be the same `laneWide`
 * branch asserted twice — the trap the session lane's recorder documents.
 *
 * WHAT IS ACTUALLY DRIVEN is the client-error → `recordFailure` path: injected
 * response → the real client's throw → the real `processFile` catch → the real
 * `recordFailure` → the budget it persisted. It stops there in both directions.
 * `syncFile` is a test bridge that calls `syncPlan` on a hand-built plan
 * request, so the real `TranscriptSyncExecutor.syncFile` above it — egress gate,
 * `markUploading` claim, size cap, plan preparation, the upload itself — does
 * not run, and neither does the libSQL store beneath it (`fakeStore`). Those are
 * this lane's request-preparation and egress paths, and no cell here reaches
 * them.
 */
export async function observeTranscriptLane(cell: Cell): Promise<Observation> {
  const client = createDesktopTranscriptsClient({
    fetch: () => Promise.resolve(failureResponse(cell)),
    getAccessToken: () => Promise.resolve(TOKEN),
    getApiOrigin: () => ORIGIN,
  });
  const row = fingerprint({ externalSessionId: SESSION_ID });
  const store = fakeStore([row]);
  let thrown: unknown;
  const queue = new TranscriptDrainQueue({
    shouldRun: () => true,
    resolveRuntime: () => ({
      store,
      executor: fakeExecutor({
        syncFile: async () => {
          try {
            await client.syncPlan(transcriptPlanRequest());
          } catch (error) {
            thrown = error;
            throw error;
          }
          return { kind: "noop" };
        },
      }),
    }),
    getComputeTargetId: () => TARGET,
    now: () => NOW,
    log: () => undefined,
    concurrency: 1,
  });
  await queue.drainOnce();
  if (!(thrown instanceof TranscriptSyncClientError)) {
    return {
      class: StandardClass.Environmental,
      defect:
        "the control plane did not throw its own typed error, so the lane has nothing to classify",
    };
  }
  if (thrown.status === undefined) {
    return {
      class: StandardClass.Item,
      defect:
        "the client dropped the response status, so no lane could classify on it",
    };
  }
  const [failure, ...extra] = store.failures;
  if (failure === undefined || extra.length > 0) {
    return {
      class: StandardClass.Environmental,
      defect: `the drain wrote ${store.failures.length} failure settle(s) for one injected failure, so no single verdict was recorded`,
    };
  }
  if (failure.retryCount === row.retryCount) {
    return { class: StandardClass.Environmental, defect: null };
  }
  if (failure.retryCount === row.retryCount + 1) {
    return { class: StandardClass.Item, defect: null };
  }
  return {
    class: StandardClass.Environmental,
    defect: `recordFailure wrote retryCount ${failure.retryCount} against a row at ${row.retryCount}, which is neither frozen nor charged`,
  };
}
