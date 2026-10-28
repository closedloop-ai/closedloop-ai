import { type TransactionClient, withDb } from "@repo/database";

/**
 * A caller's record of a write, run on the write's own transaction once the
 * write has succeeded, so the record and the write commit or roll back
 * together (ISS-10993, ISS-12552). A throw from it aborts the write.
 */
export type RecordWriteInTransaction<T> = (
  tx: TransactionClient,
  written: T
) => Promise<void>;

/**
 * ISS-12552 flag-off parity: the one place a service write picks its shape.
 *
 * A route hands a service `record` only when the request records the write
 * (`OperationReceiptRecorder.whenRecording`); for a session caller, or an
 * API-key caller while `attribution-evidence-policy` is off, it is undefined.
 * Undefined runs `unrecorded`, the write exactly as it shipped before receipts
 * existed: the same statements, transactions and error handling. Defined runs
 * `recorded`, the shape that commits the record with the write.
 */
export function writeInShape<T, R>(
  record: RecordWriteInTransaction<T> | undefined,
  shapes: {
    unrecorded: () => Promise<R>;
    recorded: (record: RecordWriteInTransaction<T>) => Promise<R>;
  }
): Promise<R> {
  return record ? shapes.recorded(record) : shapes.unrecorded();
}

/**
 * {@link writeInShape} for a write that had no transaction of its own.
 * Unrecorded, it still runs with none. Recorded, the write and `record` share
 * one transaction, so a record that cannot be stored rolls the write back.
 * The write must reach the database through `withDb`, which joins that
 * transaction, never through a client it already holds, or it commits on its
 * own outside the record's transaction.
 */
export function writeRecorded<T, R>(
  record: RecordWriteInTransaction<T> | undefined,
  write: () => Promise<R>,
  written: (result: R) => T
): Promise<R> {
  return writeInShape(record, {
    unrecorded: write,
    recorded: (recordWrite) =>
      withDb.tx(async (tx) => {
        const result = await write();
        await recordWrite(tx, written(result));
        return result;
      }),
  });
}

/** Hands an effect to run once the enclosing transaction has committed. */
export type DeferEffect = (effect: () => void) => void;

/**
 * The second write of a {@link FollowOnWrite}. `defer` is set only when it
 * runs inside another write's transaction; without it, effects are immediate.
 */
export type FollowOnWriteStep<T> = (
  defer: DeferEffect | undefined
) => Promise<T>;

/**
 * ISS-12552 flag-off parity: a write that main committed on its own AFTER
 * another write and that write's post-commit work, such as an entity's custom
 * fields after the entity. The caller calls `inTransaction` inside the first
 * write's transaction and `afterCommit` where main ran the second write; the
 * record decides which of the two runs it, so the caller never branches.
 *
 * - Recorded: `inTransaction(tx, defer)` runs the write on the first write's
 *   transaction, then `record(tx, written)`, so the record covers both and a
 *   throw rolls both back; the write's effects go to `defer`. `afterCommit`
 *   resolves undefined.
 * - Unrecorded: `inTransaction` resolves undefined and `afterCommit` runs the
 *   write with immediate effects, as main did. A throw there reaches the
 *   caller after the first write has committed, which is main's behavior.
 */
export type FollowOnWrite<T> = {
  inTransaction: (
    tx: TransactionClient,
    defer: DeferEffect
  ) => Promise<T | undefined>;
  afterCommit: () => Promise<T | undefined>;
};

export function followOnWrite<T>(
  record: RecordWriteInTransaction<T> | undefined,
  write: FollowOnWriteStep<T>
): FollowOnWrite<T> {
  return {
    inTransaction: (tx, defer) =>
      writeInShape(record, {
        unrecorded: () => Promise.resolve(undefined),
        recorded: async (recordWrite) => {
          const written = await write(defer);
          await recordWrite(tx, written);
          return written;
        },
      }),
    afterCommit: () =>
      writeInShape(record, {
        unrecorded: () => write(undefined),
        recorded: () => Promise.resolve(undefined),
      }),
  };
}

/**
 * `record` fed a value derived from what was written, or undefined when there
 * is no record, so a caller can adapt a record without branching on it.
 */
export function mapRecordedWrite<T, U>(
  record: RecordWriteInTransaction<U> | undefined,
  map: (written: T) => U
): RecordWriteInTransaction<T> | undefined {
  if (!record) {
    return undefined;
  }
  return (tx, written) => record(tx, map(written));
}
