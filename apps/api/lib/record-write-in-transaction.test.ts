import { type TransactionClient, withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  tx: {} as TransactionClient,
  pooled: {} as TransactionClient,
  transactions: 0,
}));

/**
 * `withDb` as the real one behaves: inside `withDb.tx` it hands out the
 * ambient transaction, outside it a pooled client.
 */
vi.mock("@repo/database", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const ambient = new AsyncLocalStorage<TransactionClient>();
  return {
    withDb: Object.assign(
      vi.fn((run: (db: TransactionClient) => unknown) =>
        run(ambient.getStore() ?? database.pooled)
      ),
      {
        tx: vi.fn((run: (tx: TransactionClient) => Promise<unknown>) => {
          const joined = ambient.getStore();
          if (joined) {
            return run(joined);
          }
          database.transactions += 1;
          return ambient.run(database.tx, () => run(database.tx));
        }),
      }
    ),
  };
});

import {
  type DeferEffect,
  followOnWrite,
  mapRecordedWrite,
  writeInShape,
  writeRecorded,
} from "./record-write-in-transaction";

describe("writeInShape", () => {
  it("runs the unrecorded shape when no record is handed over", async () => {
    const recorded = vi.fn(async () => "recorded");

    const result = await writeInShape(undefined, {
      unrecorded: async () => "unrecorded",
      recorded,
    });

    expect(result).toBe("unrecorded");
    expect(recorded).not.toHaveBeenCalled();
  });

  it("runs the recorded shape with the record when one is handed over", async () => {
    const record = vi.fn(async () => undefined);
    const unrecorded = vi.fn(async () => "unrecorded");

    const result = await writeInShape(record, {
      unrecorded,
      recorded: async (handed) => (handed === record ? "recorded" : "wrong"),
    });

    expect(result).toBe("recorded");
    expect(unrecorded).not.toHaveBeenCalled();
  });
});

describe("writeRecorded", () => {
  beforeEach(() => {
    database.transactions = 0;
  });

  it("opens no transaction when nothing is recorded", async () => {
    const write = vi.fn(async () => "row-1");

    expect(await writeRecorded(undefined, write, (id) => ({ id }))).toBe(
      "row-1"
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(database.transactions).toBe(0);
  });

  it("records the write on the one transaction it runs in", async () => {
    const record = vi.fn(async () => undefined);

    expect(
      await writeRecorded(
        record,
        async () => "row-1",
        (id) => ({ id })
      )
    ).toBe("row-1");
    expect(database.transactions).toBe(1);
    expect(record).toHaveBeenCalledWith(database.tx, { id: "row-1" });
  });

  it("lands a write made through withDb on the transaction the record receives", async () => {
    const clients: TransactionClient[] = [];
    const record = vi.fn((tx: TransactionClient, _written: { id: string }) => {
      clients.push(tx);
      return Promise.resolve();
    });

    await writeRecorded(
      record,
      () =>
        withDb((db) => {
          clients.push(db);
          return Promise.resolve("row-1");
        }),
      (id) => ({ id })
    );

    expect(clients).toEqual([database.tx, database.tx]);
    expect(clients[0]).toBe(clients[1]);
  });

  it("lands an unrecorded write made through withDb on a pooled client", async () => {
    let client: TransactionClient | undefined;

    await writeRecorded(
      undefined,
      () =>
        withDb((db) => {
          client = db;
          return Promise.resolve("row-1");
        }),
      (id) => ({ id })
    );

    expect(client).toBe(database.pooled);
    expect(database.transactions).toBe(0);
  });

  it("rejects with the record's failure, after the write ran", async () => {
    const write = vi.fn(async () => "row-1");
    const record = vi.fn(() =>
      Promise.reject(new Error("receipt insert failed"))
    );

    await expect(
      writeRecorded(record, write, (id) => ({ id }))
    ).rejects.toThrow("receipt insert failed");
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("followOnWrite", () => {
  it("runs the write inside the first write's transaction, then its record, when recorded", async () => {
    const order: string[] = [];
    const effects: (() => void)[] = [];
    const write = vi.fn((defer: DeferEffect | undefined) => {
      order.push("write");
      defer?.(() => undefined);
      return Promise.resolve(["field-1"]);
    });
    const record = vi.fn((_tx: TransactionClient, _written: string[]) => {
      order.push("record");
      return Promise.resolve();
    });
    const followOn = followOnWrite(record, write);

    expect(
      await followOn.inTransaction(database.tx, (effect) =>
        effects.push(effect)
      )
    ).toEqual(["field-1"]);
    expect(await followOn.afterCommit()).toBe(undefined);
    expect(order).toEqual(["write", "record"]);
    expect(record).toHaveBeenCalledWith(database.tx, ["field-1"]);
    expect(effects).toHaveLength(1);
  });

  it("runs the write after the commit, with immediate effects, when unrecorded", async () => {
    const deferred: (() => void)[] = [];
    const write = vi.fn((defer: DeferEffect | undefined) =>
      Promise.resolve(defer === undefined ? "after-commit" : "deferred")
    );
    const followOn = followOnWrite(undefined, write);

    expect(
      await followOn.inTransaction(database.tx, (effect) =>
        deferred.push(effect)
      )
    ).toBe(undefined);
    expect(write).not.toHaveBeenCalled();
    expect(await followOn.afterCommit()).toBe("after-commit");
    expect(write).toHaveBeenCalledTimes(1);
    expect(deferred).toEqual([]);
  });
});

describe("mapRecordedWrite", () => {
  it("feeds the record the mapped value, and stays absent without a record", async () => {
    const record = vi.fn((_tx: TransactionClient, _length: number) =>
      Promise.resolve()
    );

    await mapRecordedWrite(record, (written: string) => written.length)?.(
      database.tx,
      "four"
    );

    expect(record).toHaveBeenCalledWith(database.tx, 4);
    expect(
      mapRecordedWrite(undefined, (written: string) => written.length)
    ).toBe(undefined);
  });
});
