/**
 * @file ingest-batch-resume-cursor-store.ts
 * @description ISS-9839: the SQLite implementation of
 * {@link BatchResumeCursorStore}, the durable backing for the ISS-5161
 * BATCH-harness resume cursor.
 *
 * One table, one module, every function takes the Prisma handle explicitly —
 * the `sync-outbox-store.ts` conventions. It lives HERE rather than beside the
 * cursor because `collectors/` may not import `agentDatabase` or
 * `@repo/database` (ISS-9837 R1c): the engine sees only the narrow port, and the
 * runtime that owns the database supplies this.
 *
 * `ingest_batch_resume_cursor` holds exactly one row. The cursor is a
 * WHOLE-STORE value carrying a store-wide FORMAT version, so a single upsert IS
 * the atomic write the previous temp-file-plus-rename provided, and a format the
 * running build does not know is discarded wholesale by the reader rather than
 * retained row by row.
 *
 * ## Why the write is a `store:` op and the reads are not
 *
 * The collector engine runs in MAIN, which holds the database as the FEA-2038
 * forwarding proxy. `DbHostPrisma` omits `write` because its callback cannot be
 * structured-cloned across IPC, so the upsert is registered as a clone-safe
 * `store:` op and executes in the db-host child. The two reads are plain
 * delegate/raw calls with serializable args, which the proxy forwards op-by-op,
 * so they stay here.
 */
import { z } from "zod";
import type {
  BatchResumeCursorStore,
  PersistedBatchResumeCursors,
} from "../collectors/engine/collector-manager-batch-resume.js";
import type { DbHostPrisma, DesktopPrisma } from "./prisma-client.js";
import { WriteQueueClass } from "./write-queue.js";

/**
 * The singleton row key. Constant rather than derived: there is one batch-resume
 * cursor for the whole store, and a second row would be a second format.
 */
const INGEST_BATCH_RESUME_CURSOR_ID = "batch-resume";

/**
 * The `store:` op name for the write. A write cannot cross the db-host proxy
 * (`DbHostPrisma` omits `write`, so a write through it is a compile error), so
 * main forwards the upsert into the db-host child by name.
 */
export const INGEST_BATCH_RESUME_CURSOR_WRITE_OP =
  "ingestBatchResumeCursor.write";

/**
 * Args as they arrive in the db-host child — a process boundary, so they are
 * parsed there rather than trusted. The payload's own SHAPE (the cursor map
 * inside `cursors`) is deliberately NOT validated here: this store persists an
 * opaque string, and the cursor module validates it on the way back out, which
 * is where a malformed payload has to degrade to "no cursor" anyway.
 */
export const ingestBatchResumeCursorWriteArgsSchema = z.tuple([
  z.object({
    version: z.number().int(),
    cursors: z.string(),
  }),
]);

/**
 * `length()` on TEXT counts CHARACTERS, so the payload is cast to a BLOB to get
 * BYTES — the unit the cursor's `MAX_CURSOR_PAYLOAD_BYTES` ceiling is expressed
 * in, and the one a multi-byte source path would otherwise understate.
 */
const CURSOR_BYTE_LENGTH_SQL =
  'SELECT length(CAST("cursors" AS BLOB)) AS bytes FROM "ingest_batch_resume_cursor" WHERE "id" = ?';

export type IngestBatchResumeCursorStoreDeps = {
  /** Main's read view of the database (the db-host forwarding proxy). */
  prisma: DbHostPrisma;
  /** Forwards the write into the db-host child. */
  invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
};

export function createIngestBatchResumeCursorStore(
  deps: IngestBatchResumeCursorStoreDeps
): BatchResumeCursorStore {
  return {
    byteLength: () => readCursorByteLength(deps.prisma),
    read: () => readIngestBatchResumeCursor(deps.prisma),
    write: async (payload) => {
      await deps.invokeStoreOp(INGEST_BATCH_RESUME_CURSOR_WRITE_OP, [payload]);
    },
  };
}

/**
 * Byte size of the persisted payload, or `null` when no cursor is stored. Asked
 * BEFORE the payload so an oversized one is rejected without ever being
 * materialized — and, across the db-host proxy, without being cloned into main.
 */
async function readCursorByteLength(
  prisma: DbHostPrisma
): Promise<number | null> {
  const rows = await prisma.client.$queryRawUnsafe<
    { bytes: number | bigint }[]
  >(CURSOR_BYTE_LENGTH_SQL, INGEST_BATCH_RESUME_CURSOR_ID);
  const bytes = rows.at(0)?.bytes;
  return bytes === undefined ? null : Number(bytes);
}

async function readIngestBatchResumeCursor(
  prisma: DbHostPrisma
): Promise<PersistedBatchResumeCursors | null> {
  const row = await prisma.client.ingestBatchResumeCursor.findUnique({
    where: { id: INGEST_BATCH_RESUME_CURSOR_ID },
    select: { version: true, cursors: true },
  });
  return row === null ? null : { version: row.version, cursors: row.cursors };
}

/**
 * Replace the persisted payload. Runs in the db-host child (see the `store:` op
 * above). `Bulk` because every caller is on the low-duty backfill path this
 * cursor exists for, so it must not preempt the hot-path transcript/component
 * writes; the weighted round-robin still lands it promptly on the quit path,
 * which is what keeps the terminal flush's await bounded.
 */
export async function writeIngestBatchResumeCursor(
  prisma: DesktopPrisma,
  payload: PersistedBatchResumeCursors
): Promise<void> {
  await prisma.write(
    (client) =>
      client.ingestBatchResumeCursor.upsert({
        where: { id: INGEST_BATCH_RESUME_CURSOR_ID },
        create: {
          id: INGEST_BATCH_RESUME_CURSOR_ID,
          version: payload.version,
          cursors: payload.cursors,
        },
        update: { version: payload.version, cursors: payload.cursors },
      }),
    undefined,
    { class: WriteQueueClass.Bulk }
  );
}
