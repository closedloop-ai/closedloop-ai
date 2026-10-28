/**
 * @file batch-resume-cursor-fixtures.ts
 * @description Shared fixtures for the ISS-5161 batch-resume cursor's
 * persistence boundary, which ISS-9839 moved from a JSON file to SQLite behind
 * the injected {@link BatchResumeCursorStore} port.
 *
 * Two mediums, for two different questions.
 *
 * {@link batchResumeCursorMedium} is an in-memory stand-in for the port, with
 * knobs for the failures a durable medium can hand back: an unreadable store and
 * an unwritable one. It is what the store's own UNIT cases use — they ask "does
 * the cursor round-trip, degrade, and stay bounded", which is a question about
 * `BatchResumeCursors`, not about SQLite.
 *
 * {@link sqliteBatchResumeCursorStore} is the REAL table, reached through the
 * real `createIngestBatchResumeCursorStore` over a real libSQL database. Only
 * the db-host IPC hop is faked, and even that dispatches through the production
 * arg schema into the production write, so a drift between the op's declared
 * args and its body still fails. It is what the cases that must prove the cursor
 * actually persists to SQLite use.
 */
import type {
  BatchResumeCursorStore,
  PersistedBatchResumeCursors,
} from "../../src/main/collectors/engine/collector-manager-batch-resume.js";
import {
  createIngestBatchResumeCursorStore,
  INGEST_BATCH_RESUME_CURSOR_WRITE_OP,
  ingestBatchResumeCursorWriteArgsSchema,
  writeIngestBatchResumeCursor,
} from "../../src/main/database/ingest-batch-resume-cursor-store.js";
import type { DesktopPrisma } from "../../src/main/database/prisma-client.js";

export type BatchResumeCursorMedium = {
  /**
   * What is currently persisted, readable and writable by the test directly —
   * this is the "hand-edited state on disk" the load path has to survive.
   */
  payload: PersistedBatchResumeCursors | null;
  /** Make every read throw, the way an unreadable durable store does. */
  readError: Error | null;
  /** Make every write throw, the way an unwritable one does. */
  writeError: Error | null;
  /** The port handed to `new BatchResumeCursors({ store })`. */
  port: BatchResumeCursorStore;
};

/** An in-memory {@link BatchResumeCursorStore} with injectable read/write failures. */
export function batchResumeCursorMedium(): BatchResumeCursorMedium {
  const medium: BatchResumeCursorMedium = {
    payload: null,
    readError: null,
    writeError: null,
    port: {
      byteLength: () => {
        if (medium.readError) {
          return Promise.reject(medium.readError);
        }
        return Promise.resolve(
          medium.payload === null
            ? null
            : Buffer.byteLength(medium.payload.cursors, "utf8")
        );
      },
      read: () => {
        if (medium.readError) {
          return Promise.reject(medium.readError);
        }
        return Promise.resolve(medium.payload);
      },
      write: (payload) => {
        if (medium.writeError) {
          return Promise.reject(medium.writeError);
        }
        medium.payload = payload;
        return Promise.resolve();
      },
    },
  };
  return medium;
}

/**
 * The production port over a real `ingest_batch_resume_cursor` table. The
 * `invokeStoreOp` seam stands in for the db-host IPC hop only: it parses with
 * the production schema and calls the production write, so this still exercises
 * the op body a main-process flush actually reaches.
 */
export function sqliteBatchResumeCursorStore(
  prisma: DesktopPrisma
): BatchResumeCursorStore {
  return createIngestBatchResumeCursorStore({
    prisma,
    invokeStoreOp: (name, args = []) =>
      runIngestBatchResumeCursorStoreOp(prisma, name, args),
  });
}

/**
 * The cursor's `store:` op body, executed the way the db-host child executes it:
 * the production arg schema, then the production write.
 *
 * Shared so a suite that drives the flush over a REAL `DbHostClient` (the
 * ISS-9839 shutdown-window case) runs the same op body as the direct fixture
 * above, rather than restating it beside its own fake child.
 */
export function runIngestBatchResumeCursorStoreOp(
  prisma: DesktopPrisma,
  name: string,
  args: unknown[]
): Promise<null> {
  if (name !== INGEST_BATCH_RESUME_CURSOR_WRITE_OP) {
    throw new Error(`unexpected store op: ${name}`);
  }
  const [payload] = ingestBatchResumeCursorWriteArgsSchema.parse(args);
  return writeIngestBatchResumeCursor(prisma, payload).then(() => null);
}
