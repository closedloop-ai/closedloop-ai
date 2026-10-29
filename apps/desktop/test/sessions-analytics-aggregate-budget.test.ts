/**
 * ISS-10606: the desktop analytics aggregate must survive a store thread held
 * by an op it does not own, keep its ISS-9802 statement-boundary cancellation,
 * and never answer a failure with an aggregate that reads as "no data".
 *
 * Driven through `createSqliteSessionSyncSource(...).aggregateAnalytics` over a
 * fake store thread, the pattern `sessions-usage-aggregate-budget.test.ts` set
 * for the usage twin: `TRANSACTION_TIMEOUT_MS` is wall clock, so a check-phase
 * boundary inside a transaction lets a queued foreign op spend the budget.
 */
import { describe, expect, it } from "vitest";
import { createSessionAttributionResolverCache } from "../src/main/agent-sync/agent-session-attribution.js";
import {
  markStoreReadCancelled,
  runStoreReadUnderCancellation,
} from "../src/main/database/db-host/store-read-cancellation.js";
import { yieldDbHostLoop } from "../src/main/database/db-host/yield-db-host-loop.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import {
  READ_CANCELLED_ERROR_MESSAGE,
  READ_CANCELLED_ERROR_NAME,
} from "../src/shared/read-cancellation-contract.js";
import { DB_HOST_EXITED_SIGNATURE } from "../src/shared/transient-db-host-error.js";

/** Prisma's wording, a literal because the truth is the driver's, not ours. */
const EXPIRED_TRANSACTION_MESSAGE =
  "Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 120000 ms, however 297052 ms passed since the start of the transaction.";

/** SQL only that statement contains, so the array order never picks the label. */
const STATEMENT_MARKERS = [
  ["AS invalid_cost", "validateOperands"],
  ["AS tool_name", "byTool"],
  ["AS agent_type", "byAgentType"],
  ["per_session_errors", "byRepository"],
  ["AS unpriced_input_tokens", "byRepositoryCost"],
] as const;

const TOOL_ROW = {
  tool_name: "Read",
  invocation_count: 3,
  error_count: 1,
  session_count: 2,
};

type StoreThreadFake = {
  prisma: DesktopPrisma;
  /** Statement labels plus `tx-open` / `tx-close`, in execution order. */
  trace: string[];
};

function statementLabel(sql: string): string {
  const match = STATEMENT_MARKERS.find(([marker]) => sql.includes(marker));
  if (!match) {
    throw new Error(`unrecognised analytics statement: ${sql}`);
  }
  return match[1];
}

/**
 * A store thread with a foreign op queued at every transaction open. The op
 * takes the thread at the first check-phase boundary that transaction reaches
 * and hands it back only once the whole budget is gone, so the next statement
 * inside it faults exactly as Prisma's does. `onStatement` is where a test
 * posts a cancel mid-read.
 */
function createStoreThreadFake(
  onStatement?: (label: string) => void
): StoreThreadFake {
  const trace: string[] = [];
  let insideTransaction = false;
  let budgetSpent = false;

  const run = (sql: string, transactional: boolean) => {
    if (transactional && budgetSpent) {
      throw new Error(EXPIRED_TRANSACTION_MESSAGE);
    }
    const label = statementLabel(sql);
    trace.push(label);
    onStatement?.(label);
    return Promise.resolve(label === "byTool" ? [TOOL_ROW] : []);
  };
  const tx = { $queryRawUnsafe: (sql: string) => run(sql, true) };
  const reader = {
    $queryRawUnsafe: (sql: string) => run(sql, false),
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => {
      insideTransaction = true;
      trace.push("tx-open");
      setImmediate(() => {
        if (insideTransaction) {
          budgetSpent = true;
        }
      });
      try {
        return await fn(tx);
      } finally {
        insideTransaction = false;
        trace.push("tx-close");
      }
    },
  };
  const prisma = {
    read: <T>(fn: (client: typeof reader) => Promise<T>) => fn(reader),
    write: () => Promise.reject(new Error("aggregateAnalytics must not write")),
  };
  return { prisma: prisma as unknown as DesktopPrisma, trace };
}

/** The rejection `run` produced, or `null` when it resolved. */
async function captureRejection(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

describe("ISS-10606: analytics aggregate over a contended store thread", () => {
  it("positive control: the fake spends the budget when a yield lands inside a transaction", async () => {
    const { prisma, trace } = createStoreThreadFake();

    const inTransaction = prisma.read((reader) =>
      reader.$transaction(async (tx) => {
        await tx.$queryRawUnsafe("SELECT 1 AS tool_name");
        await yieldDbHostLoop();
        await tx.$queryRawUnsafe("SELECT 1 AS agent_type");
      })
    );

    await expect(inTransaction).rejects.toThrow(EXPIRED_TRANSACTION_MESSAGE);
    expect(trace).toEqual(["tx-open", "byTool", "tx-close"]);
  });

  it("runs every statement without spending a transaction's budget on a foreign op", async () => {
    const { prisma, trace } = createStoreThreadFake();
    const logged: string[] = [];
    const source = createSqliteSessionSyncSource(prisma, (message) =>
      logged.push(message)
    );

    const aggregate = await source.aggregateAnalytics?.(
      {},
      createSessionAttributionResolverCache()
    );

    expect(trace).toEqual([
      "tx-open",
      "validateOperands",
      "byTool",
      "byAgentType",
      "byRepository",
      "byRepositoryCost",
      "tx-close",
    ]);
    expect(aggregate?.byTool).toEqual([
      { toolName: "Read", invocationCount: 3, errorCount: 1, sessionCount: 2 },
    ]);
    expect(logged).toEqual([]);
  });

  it("observes a cancel posted during byTool before byAgentType runs", async () => {
    // A distinct token: `markStoreReadCancelled` remembers tokens process-wide.
    const token = "iss10606-cancelled-during-by-tool";
    const { prisma, trace } = createStoreThreadFake((label) => {
      if (label === "byTool") {
        markStoreReadCancelled(token);
      }
    });
    const logged: string[] = [];
    const source = createSqliteSessionSyncSource(prisma, (message) =>
      logged.push(message)
    );

    const error = await captureRejection(() =>
      runStoreReadUnderCancellation(
        token,
        async () =>
          await source.aggregateAnalytics?.(
            {},
            createSessionAttributionResolverCache()
          )
      )
    );

    expect(error).toMatchObject({ name: READ_CANCELLED_ERROR_NAME });
    expect(trace).toEqual([
      "tx-open",
      "validateOperands",
      "byTool",
      "tx-close",
    ]);
    expect(logged).toEqual([]);
  });

  it.each([
    [
      "a cancellation",
      Object.assign(new Error(READ_CANCELLED_ERROR_MESSAGE), {
        name: READ_CANCELLED_ERROR_NAME,
      }),
    ],
    [
      "a db-host lifecycle failure",
      new Error(`${DB_HOST_EXITED_SIGNATURE} (code: 0)`),
    ],
  ])(
    "rejects %s unchanged so its downstream classification survives",
    async (_label, failure) => {
      const prisma = {
        read: () => Promise.reject(failure),
        write: () => Promise.reject(failure),
      };
      const logged: string[] = [];
      const source = createSqliteSessionSyncSource(
        prisma as unknown as DesktopPrisma,
        (message) => logged.push(message)
      );

      const error = await captureRejection(() =>
        source.aggregateAnalytics?.({}, createSessionAttributionResolverCache())
      );

      expect(error).toBe(failure);
      expect(logged).toEqual([]);
    }
  );
});
