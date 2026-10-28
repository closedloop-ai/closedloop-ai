/**
 * @file wire-org-directory-persistence.ts
 * @description FEA-3457's durable org-directory wiring, lifted out of `app.ts`.
 *
 * Extracted by ISS-9197 under the shrink-only rule in AGENTS.md ("File Size and
 * Organization"): that ticket had to add one accessor to the bootstrap deps bag
 * `app.ts` builds, and a grandfathered file must never grow. This is the
 * cohesive unit next to it — pure wiring, one caller, and its two collaborators
 * are its own siblings in this directory, so the move follows the subject rather
 * than re-homing anything.
 *
 * The dynamic imports are load-bearing and deliberately preserved verbatim:
 * they keep `electron-store` off the eager boot path, so it is pulled in only
 * alongside the dashboard runtime. A static import here would undo the property
 * the original comment records.
 */

import { app } from "electron";
import { gatewayLog } from "../logging/gateway-logger.js";

/**
 * Wire the durable org-directory snapshot store (FEA-3457). Idempotent — the
 * cache layer resets its rehydrate guard on each configure, and the store is
 * scoped to the app's `userData` dir. Dynamically imported so electron-store
 * for this cache is loaded only alongside the dashboard runtime.
 *
 * Named `wire…` rather than `configure…` because `org-directory-cache.js`
 * already exports a `configureOrgDirectoryPersistence`, which this calls; two
 * identically-named functions one import apart is how a reader ends up wiring
 * the wrong one.
 */
export async function wireOrgDirectoryPersistence(): Promise<void> {
  const [
    { configureOrgDirectoryPersistence },
    { createOrgDirectoryPersistenceStore },
  ] = await Promise.all([
    import("./org-directory-cache.js"),
    import("./org-directory-persistence-store.js"),
  ]);
  configureOrgDirectoryPersistence(
    createOrgDirectoryPersistenceStore({
      cwd: app.getPath("userData"),
      // FEA-3517: surface a corrupt persisted directory shrinking boot-time
      // owner attribution to the main-process log (server-only discipline),
      // so the skip is diagnosable rather than a silent swallow.
      onCorruptEntriesDropped: ({ kept, dropped }) =>
        gatewayLog.warn(
          "org-directory",
          `Dropped ${dropped} malformed persisted org-directory user(s) on rehydrate; kept ${kept}.`
        ),
    })
  );
}
