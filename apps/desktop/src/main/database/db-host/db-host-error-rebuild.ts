/**
 * @file db-host-error-rebuild.ts
 * @description Reconstructing a db-host child's error on the main side.
 *
 * The inverse of `serializeDbHostError` (`db-host-protocol.ts`). Extracted from
 * `db-host-client.ts` (ISS-8776) so the transport keeps the child LIFECYCLE and
 * this module keeps the structured-clone boundary — two responsibilities the
 * client had grown to hold at once, and the reason it crossed the file-size
 * ceiling.
 *
 * Everything here exists because a structured clone drops the PROTOTYPE. Each
 * field below is one classification that could not survive the hop and had to
 * be carried as data and re-attached: the two of them are the whole subject.
 */

import {
  attachStorageExhaustionReason,
  isStorageExhaustionReason,
} from "../../../shared/storage-exhaustion.js";
import {
  DesktopMigrationError,
  toMigrationRefusalKind,
} from "../../lifecycle/migration-refusal.js";
import { type DbHostResponse, DbHostResponseKind } from "./db-host-protocol.js";

/**
 * Rebuild the `Error` a child reported, restoring what the clone flattened.
 */
export function rebuildError(response: DbHostResponse): Error {
  if (
    response.kind === DbHostResponseKind.Result ||
    response.kind === DbHostResponseKind.Ready
  ) {
    const message = response.error?.message ?? "db-host error";
    // ISS-4714: a migration refusal thrown in the DB-host child loses its
    // prototype (and so its `kind`) crossing the structured-clone boundary. When
    // the serialized error carried a validated refusal kind, rebuild the typed
    // `DesktopMigrationError` so main-side classification (`isDbAheadOfAppError`)
    // still fires in production — not just in the in-process test.
    const refusalKind = toMigrationRefusalKind(response.error?.refusalKind);
    const error =
      refusalKind === null
        ? new Error(message)
        : new DesktopMigrationError(refusalKind, message);
    if (response.error?.stack) {
      error.stack = response.error.stack;
    }
    // A rebuilt DesktopMigrationError already carries name "DesktopMigrationError";
    // only override for the plain-Error path so a serialized custom name survives.
    if (refusalKind === null && response.error?.name) {
      error.name = response.error.name;
    }
    // ISS-6337: restore the disk-full verdict the child made from the result
    // code. Validated rather than trusted — this is the same structured-clone
    // boundary the rest of this function treats as untrusted.
    const storageReason = response.error?.storageExhaustionReason;
    if (isStorageExhaustionReason(storageReason)) {
      attachStorageExhaustionReason(error, storageReason);
    }
    return error;
  }
  return new Error("db-host error");
}
