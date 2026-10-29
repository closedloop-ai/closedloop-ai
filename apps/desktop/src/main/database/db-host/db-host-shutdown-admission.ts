/**
 * @file db-host-shutdown-admission.ts
 * @description ISS-9839 / ISS-9914 — the db-host ops `DbHostClient.invoke`
 * still admits while the ISS-4713 intentional-shutdown window is open
 * (`beginClosing()` sent, `close()` not yet entered).
 *
 * TERMINAL FLUSHES ONLY: writes the app issues inside that window BECAUSE it is
 * quitting, whose only value is landing before the child goes away. The app
 * opens the window FIRST and only then awaits `stopAgentCapture()`
 * (`desktop-application-shutdown.ts`), and that teardown is what flushes the
 * collector epoch's persisted stores (`collector-manager-shutdown.ts`): the
 * ISS-5161 batch-resume cursor, and the ISS-9838 ingest stores (each
 * collector's catchup cache and parse quarantine). Refusing them discarded each
 * store's tail since its last flush on every graceful quit, and logged a
 * failure on the monitored collector channel while doing it.
 *
 * Keyed on the WIRE op name and decided HERE, inside the gate, rather than by a
 * caller-supplied flag: this list is the only answer to "which writes may cross
 * a closing db-host", and no call site can opt itself in. It relaxes only the
 * `closing` half of the gate — a `closed` client refuses every op, because by
 * then the drain has run and the child is being killed.
 */
import { INGEST_BATCH_RESUME_CURSOR_WRITE_OP } from "../ingest-batch-resume-cursor-store.js";
import type { DbHostAgentDatabase } from "../sqlite-contract.js";
import { DB_HOST_STORE_OP_PREFIX } from "./db-host-store-op-registry.js";

/**
 * The method-proxy path for an ingest-store write. Typed against the contract
 * so renaming the method fails `tsc` here instead of silently re-refusing it.
 */
const COLLECTOR_INGEST_STORE_SAVE_OP =
  "collectorIngestStores.save" satisfies `collectorIngestStores.${keyof DbHostAgentDatabase["collectorIngestStores"] & string}`;

const SHUTDOWN_ADMITTED_OPS: ReadonlySet<string> = new Set([
  `${DB_HOST_STORE_OP_PREFIX}${INGEST_BATCH_RESUME_CURSOR_WRITE_OP}`,
  COLLECTOR_INGEST_STORE_SAVE_OP,
]);

export function isAdmittedDuringShutdown(op: string): boolean {
  return SHUTDOWN_ADMITTED_OPS.has(op);
}
