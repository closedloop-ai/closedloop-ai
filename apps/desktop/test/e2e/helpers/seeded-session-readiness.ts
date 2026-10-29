/**
 * Readiness gate for a transcript the historical importer is still ingesting.
 *
 * Seeding writes `.jsonl` files to disk, but the importer parses them across
 * the utility-process boundary, so "the file exists" and "the session is in the
 * local store" are separated by an unbounded amount of work. A spec that seeds
 * and then asserts straight against the rendered list is racing that boundary:
 * it can only express the wait as a generous timeout on a UI locator, and when
 * that budget loses, the failure reads as "the list never rendered the row" —
 * which is indistinguishable from the list being genuinely broken.
 *
 * Polling the store over IPC makes the precondition explicit and moves the
 * common failure off the UI locator: an import that never lands fails here,
 * naming the session, instead of being reported as a row that never rendered.
 *
 * Two limits worth knowing before trusting a green from this gate. It polls
 * `agentSessionsApi.detail`, which is NOT the channel the Sessions list renders
 * from (`pageData`), so it proves the detail read observes the row, not that
 * the list query agrees — those have drifted before (FEA-4157). And `detail`
 * fails closed at `null`, the same answer it gives while an import is still in
 * flight, so a store that never came up times out here looking like a slow
 * import. Shared (ISS-5717) so every spec that seeds a session gates on one
 * implementation.
 */

import { expect, type Page } from "@playwright/test";
import { TRANSIENT_DB_HOST_ERROR_SIGNATURES } from "../../../src/shared/transient-db-host-error.js";

/**
 * How long one session may take to land in the store.
 *
 * Exported because a caller awaiting several of these back to back has to size
 * its own outer test timeout above their sum, and a second copy of the number
 * is what lets the two drift into an outer bound that fires first.
 */
export const SEEDED_SESSION_GATE_TIMEOUT_MS = 30_000;

/** The slice of the preload bridge this gate reads. */
type SeededSessionWindow = Window & {
  desktopApi?: {
    agentSessionsApi?: {
      detail: (id: string) => Promise<unknown | null>;
    };
  };
};

/**
 * Resolve once the importer has landed `sessionId` in the local store.
 *
 * Keeps polling through the two lifecycle races a boot-time read hits rather
 * than failing on them: a handler not yet registered (the bridge and the DB
 * host come up independently of the renderer), and a db-host restart. The
 * latter reuses the production signature list, because the renderer classifies
 * exactly those as a transient blip and shows its reconnecting state — a gate
 * that hard-failed where the app recovers would be stricter than the app.
 * Anything else rethrows immediately instead of being polled away.
 */
export async function waitForSeededSession(
  page: Page,
  sessionId: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ id, transientSignatures }) => {
            const desktopApi = (window as SeededSessionWindow).desktopApi;
            if (!desktopApi?.agentSessionsApi) {
              return "missing";
            }
            try {
              const detail = await desktopApi.agentSessionsApi.detail(id);
              return detail ? "ready" : "loading";
            } catch (error) {
              const message = (
                error instanceof Error ? error.message : String(error)
              ).toLowerCase();
              if (
                message.includes("no handler registered") ||
                transientSignatures.some((signature) =>
                  message.includes(signature)
                )
              ) {
                return "registering";
              }
              throw error;
            }
          },
          {
            id: sessionId,
            transientSignatures: TRANSIENT_DB_HOST_ERROR_SIGNATURES,
          }
        ),
      {
        message: `Seeded session ${sessionId} never landed in the local store.`,
        timeout: SEEDED_SESSION_GATE_TIMEOUT_MS,
      }
    )
    .toBe("ready");
}
