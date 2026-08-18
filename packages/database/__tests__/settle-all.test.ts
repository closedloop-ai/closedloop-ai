import { describe, expect, it, vi } from "vitest";
import { settleAll } from "./test-helpers/settle-all";

/**
 * ISS-6211 — the teardown counterpart of the fail-closed readers.
 *
 * `try { work } finally { cleanup }` drops the work's error when the cleanup
 * also rejects, and a `finally` body awaiting two closes in sequence skips the
 * second once the first rejects — a lost cause plus a leaked pool. Every case
 * below fails under that shape.
 */

const DESCRIPTION = "teardown failed";

describe("settleAll", () => {
  it("runs the steps in order when all succeed", async () => {
    const order: number[] = [];
    const record = (step: number) => () => {
      order.push(step);
      return Promise.resolve();
    };
    await settleAll([record(1), record(2), record(3)], DESCRIPTION);
    expect(order).toEqual([1, 2, 3]);
  });

  it("runs every later step even though an earlier one rejected", async () => {
    // The leak `finally { await disconnect(); await pool.end(); }` produced:
    // the close after the rejecting one never ran.
    const later = vi.fn().mockResolvedValue(undefined);
    const last = vi.fn().mockResolvedValue(undefined);
    await expect(
      settleAll(
        [() => Promise.reject(new Error("first")), later, last],
        DESCRIPTION
      )
    ).rejects.toThrow("first");
    expect(later).toHaveBeenCalledTimes(1);
    expect(last).toHaveBeenCalledTimes(1);
  });

  it("rethrows a lone failure unchanged so its type and stack survive", async () => {
    const failure = new TypeError("only");
    await expect(
      settleAll(
        [() => Promise.reject(failure), () => Promise.resolve()],
        DESCRIPTION
      )
    ).rejects.toBe(failure);
  });

  it("preserves BOTH causes when the work and the cleanup reject", async () => {
    // The defect `finally` has: the cleanup's rejection replaces the work's,
    // and the useful error — why the DELETE failed — disappears.
    const work = new Error("delete failed");
    const cleanup = new Error("disconnect failed");
    const raised = await settleAll(
      [() => Promise.reject(work), () => Promise.reject(cleanup)],
      DESCRIPTION
    ).catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(AggregateError);
    expect((raised as AggregateError).errors).toEqual([work, cleanup]);
    expect((raised as AggregateError).message).toBe(DESCRIPTION);
  });

  it("resolves when there are no steps", async () => {
    await expect(settleAll([], DESCRIPTION)).resolves.toBeUndefined();
  });
});
