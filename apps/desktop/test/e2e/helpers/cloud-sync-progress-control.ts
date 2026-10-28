/**
 * Spec-side controls for the runtime-status `cloudSync` sample (ISS-9184).
 *
 * The sample itself is published by a main-process `-r` preload — see
 * `cloud-read-readiness-preload.cjs` for WHY the seam is there and what it does
 * and does not substitute. This module is the half the spec talks to: the
 * `ElectronApplication.evaluate` calls that replace the sample mid-run and wait
 * for the renderer's shared poll to have been answered with it.
 *
 * Requires the launch to have passed `cloudReadReadiness` — that option is what
 * installs the preload, and `cloudSyncProgress` supplies the first sample.
 *
 * Deliberately electron-free and value-`@repo/*`-free, for the same reason
 * `sessions-page-data-gate.ts` is: an extension-less `@repo/*` subpath does not
 * resolve under Playwright's ESM loader, and importing one from a spec aborts the
 * WHOLE desktop-e2e suite at load time with no failing test name to point at it.
 */

import { type ElectronApplication, expect } from "@playwright/test";
import type { E2eCloudSyncProgress } from "./desktop-app";

/** The global the readiness preload publishes the sample on, in the MAIN process. */
const CONTROL_KEY = "__clE2eCloudSyncProgress";

/** What the preload publishes on that global, in the main process. */
type CloudSyncProgressControl = {
  current: E2eCloudSyncProgress | null;
  served: number;
  push: (sample: E2eCloudSyncProgress) => void;
};

/**
 * How long a pushed sample has to reach a runtime-status answer.
 *
 * The renderer's shared poll runs at 1s (`INGEST_POLL_MS`), so this is twenty
 * intervals — long enough that a slow CI box cannot flake it, short enough that
 * a runtime-status poll which is not running at all fails HERE, naming the
 * sample that never landed, rather than downstream as a missing refresh.
 */
const SAMPLE_SERVED_TIMEOUT_MS = 20_000;

type CloudSyncControlRequest =
  | { key: string; operation: "push"; progress: E2eCloudSyncProgress }
  | { key: string; operation: "served" };

/**
 * Run one control operation in the MAIN process, answering with the sample's
 * served count. Written as a single `evaluate` over an operation name rather
 * than one per accessor, because the body cannot close over anything in this
 * file (Playwright serializes it) — so each accessor would be another copy of
 * the same lookup-and-guard.
 */
function callCloudSyncControl(
  app: ElectronApplication,
  request: CloudSyncControlRequest
): Promise<number> {
  return app.evaluate((_electron, input) => {
    const control: CloudSyncProgressControl | undefined = Reflect.get(
      globalThis,
      input.key
    );
    if (!control) {
      throw new Error(
        "the cloud-sync progress preload was never installed — the launch must pass `cloudReadReadiness`"
      );
    }
    if (input.operation === "push") {
      control.push(input.progress);
    }
    return control.served;
  }, request);
}

/**
 * Publish a new `cloudSync` sample, and resolve once the runtime-status handler
 * has answered at least one poll with it.
 *
 * Waiting for the ANSWER rather than returning on the push is what keeps a
 * caller's next assertion honest. The handler runs only because the renderer's
 * own poll invoked it, so an answer carrying the new sample means the push has
 * reached the runtime-status reply that poll is waiting on — and a surface that
 * then fails to react has failed for its own reasons, not because the sample was
 * still sitting in the main process.
 */
export async function pushCloudSyncProgress(
  app: ElectronApplication,
  progress: E2eCloudSyncProgress
): Promise<void> {
  await callCloudSyncControl(app, {
    key: CONTROL_KEY,
    operation: "push",
    progress,
  });
  await expect
    .poll(
      () =>
        callCloudSyncControl(app, { key: CONTROL_KEY, operation: "served" }),
      { timeout: SAMPLE_SERVED_TIMEOUT_MS }
    )
    .toBeGreaterThan(0);
}
