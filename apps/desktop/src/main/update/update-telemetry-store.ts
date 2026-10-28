/**
 * @file update-telemetry-store.ts
 * @description ISS-7247/ISS-7225: the only filesystem access in the update lane.
 * A standalone `userData` file rather than the settings store, because a
 * DIFFERENT BUILD reads what this one wrote. Best-effort throughout: losing it
 * costs one attempt's terminal record, throwing would cost a boot.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type UpdateTelemetryState,
  UpdateTelemetryStateSchema,
} from "./update-attempt-record.js";

/** Filename under `userData`, stable across builds by contract. */
export const UPDATE_TELEMETRY_STATE_FILENAME = "update-telemetry-state.json";

/** Read/write access to the persisted update-telemetry state. */
export type UpdateTelemetryStore = {
  read: () => UpdateTelemetryState;
  write: (state: UpdateTelemetryState) => void;
  clear: () => void;
};

/**
 * Takes the directory, not a full path, so the filename stays owned here — it is
 * a cross-build contract. Absent, unreadable, non-JSON, and schema-invalid all
 * collapse to an empty state: a record half-written by a crash is
 * indistinguishable from a hostile one, and neither may be trusted.
 */
export function createUpdateTelemetryStore(
  directory: string
): UpdateTelemetryStore {
  const filePath = join(directory, UPDATE_TELEMETRY_STATE_FILENAME);
  return {
    read() {
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch {
        return {};
      }
      try {
        return UpdateTelemetryStateSchema.parse(JSON.parse(raw));
      } catch {
        return {};
      }
    },
    write(state) {
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, `${JSON.stringify(state)}\n`, "utf8");
      } catch {
        // Best-effort: an unwritable userData directory must not fail a boot or
        // block the quit that is handing off to the updater.
      }
    },
    clear() {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // Best-effort, as above.
      }
    },
  };
}
