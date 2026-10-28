import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Node } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { describe, it } from "vitest";
import { createSessionAttributionResolverCache } from "../src/main/agent-sync/agent-session-attribution.js";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  type DbHostInvokeDeps,
  dispatchDbHostInvoke,
} from "../src/main/database/db-host/db-host-invoke-dispatch.js";
import { createDbHostOpLanes } from "../src/main/database/db-host/db-host-op-lanes.js";
import {
  type DbHostRequest,
  DbHostRequestKind,
  DbHostResponseKind,
  isDbHostRequest,
} from "../src/main/database/db-host/db-host-protocol.js";
import {
  createDbStoreClient,
  type DbStoreWorkerHandle,
} from "../src/main/database/db-host/db-store-client.js";
import {
  type DbStoreRequest,
  DbStoreRequestKind,
  isDbStoreRequest,
} from "../src/main/database/db-host/db-store-protocol.js";
import {
  activeStoreReadCount,
  isStoreReadCancelled,
  markStoreReadCancelled,
  preCancelledTokenCount,
  runStoreReadUnderCancellation,
} from "../src/main/database/db-host/store-read-cancellation.js";
import { yieldDbHostLoop } from "../src/main/database/db-host/yield-db-host-loop.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import { getSharedAgentSessionsPageData } from "../src/main/session/shared-agent-sessions-page-data.js";
import { runWithReadCancellationToken } from "../src/shared/db-host-read-cancellation.js";
import {
  DESKTOP_READ_CANCELLED_RESULT,
  DesktopReadCancelledError,
  isDesktopReadCancelledResult,
  isReadCancellationToken,
  READ_CANCELLATION_TOKEN_MAX_LENGTH,
  READ_CANCELLED_ERROR_NAME,
  readCancellationTokenOf,
  rejectIfReadCancelled,
} from "../src/shared/read-cancellation-contract.js";
import type {
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import {
  createFakeSource,
  cursor,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * @file desktop-read-cancellation.test.ts
 * @description ISS-9802 — a desktop read can now be CANCELLED, not merely
 * un-awaited.
 *
 * THE DECISIVE ASSERTION IS THAT THE WORK STOPS. A test that watches the
 * renderer's promise reject proves nothing new: `readHonoringSignal` has
 * rejected on abort since ISS-7852 while the scan ran to completion behind it.
 * So every assertion below counts STATEMENTS EXECUTED on the store side after
 * the cancellation, which is the fact that changed.
 *
 * Nothing here measures time. Cancellation is driven at a chosen point in the
 * fake op's own body — the same call the store worker's `CancelRead` arm makes —
 * so the interleaving is decided by the test rather than raced for
 * (`no-timing-assertions`).
 */

const YIELDS_PER_OP = 5;
const CANCEL_AFTER_STATEMENT = 2;

describe("ISS-9802: a cancelled store read stops running", () => {
  it("abandons its remaining statements at the next checkpoint", async () => {
    const token = "renderer-a-1";
    let statements = 0;

    const op = runStoreReadUnderCancellation(token, async () => {
      for (let index = 0; index < YIELDS_PER_OP; index += 1) {
        statements += 1;
        if (statements === CANCEL_AFTER_STATEMENT) {
          // Exactly what the store worker does when a CancelRead message lands
          // while this op is between statements.
          markStoreReadCancelled(token);
        }
        await yieldDbHostLoop();
      }
      return "completed";
    });

    await assert.rejects(op, (error: Error) => {
      assert.equal(error.name, READ_CANCELLED_ERROR_NAME);
      return true;
    });
    // The statement that was already running finishes; nothing after it does.
    // That is the whole claim — statement-boundary granularity, not finer.
    assert.equal(statements, CANCEL_AFTER_STATEMENT);
  });

  it("leaves an op that was never cancelled completely untouched", async () => {
    let statements = 0;
    const value = await runStoreReadUnderCancellation(
      "renderer-a-2",
      async () => {
        for (let index = 0; index < YIELDS_PER_OP; index += 1) {
          statements += 1;
          await yieldDbHostLoop();
        }
        return "completed";
      }
    );

    assert.equal(value, "completed");
    assert.equal(statements, YIELDS_PER_OP);
  });

  it("cannot cancel an op that carries no token — every write and backfill", async () => {
    let statements = 0;
    // No token, so no scope is entered. This is the shape of every op that
    // predates ISS-9802: a cancel naming anything at all must not reach it.
    const value = await runStoreReadUnderCancellation(undefined, async () => {
      for (let index = 0; index < YIELDS_PER_OP; index += 1) {
        statements += 1;
        markStoreReadCancelled("renderer-a-3");
        await yieldDbHostLoop();
      }
      return "completed";
    });

    assert.equal(value, "completed");
    assert.equal(statements, YIELDS_PER_OP);
  });

  it("cancels ONE op, not every op sharing the thread", async () => {
    let cancelledStatements = 0;
    let bystanderStatements = 0;
    const cancelled = runStoreReadUnderCancellation(
      "renderer-a-4",
      async () => {
        for (let index = 0; index < YIELDS_PER_OP; index += 1) {
          cancelledStatements += 1;
          await yieldDbHostLoop();
        }
      }
    );
    const bystander = runStoreReadUnderCancellation(
      "renderer-a-5",
      async () => {
        for (let index = 0; index < YIELDS_PER_OP; index += 1) {
          bystanderStatements += 1;
          await yieldDbHostLoop();
        }
        return "completed";
      }
    );
    markStoreReadCancelled("renderer-a-4");

    await assert.rejects(cancelled);
    assert.equal(await bystander, "completed");
    assert.ok(cancelledStatements < YIELDS_PER_OP);
    assert.equal(bystanderStatements, YIELDS_PER_OP);
  });
});

describe("ISS-9802: the token registry cannot grow", () => {
  it("registers no in-flight entry for a token naming no read", () => {
    const before = activeStoreReadCount();

    // It reached nothing, and it adds no in-flight entry. It IS remembered in
    // the bounded pre-cancel ring (covered below), because the op it names may
    // still be in transit — but that ring is capped, and this map is not the
    // thing an outside caller could grow.
    assert.equal(markStoreReadCancelled("never-registered"), false);
    assert.equal(activeStoreReadCount(), before);
  });

  it("caps the pre-cancel ring however many unknown tokens arrive", () => {
    for (let index = 0; index < 500; index += 1) {
      markStoreReadCancelled(`flood-${index}`);
    }

    // The one map here keyed by input a caller controls without limit. 64 is the
    // cap; the assertion is that SOME finite cap holds under 500 arrivals.
    assert.ok(
      preCancelledTokenCount() <= 64,
      `pre-cancel ring grew to ${preCancelledTokenCount()}`
    );
  });

  it("releases its entry when the op settles, either way", async () => {
    const before = activeStoreReadCount();

    await runStoreReadUnderCancellation("renderer-b-1", () =>
      Promise.resolve("done")
    );
    assert.equal(activeStoreReadCount(), before);

    await assert.rejects(
      runStoreReadUnderCancellation("renderer-b-2", () =>
        Promise.reject(new Error("store failed"))
      )
    );
    assert.equal(activeStoreReadCount(), before);
    // And a cancel arriving after the op released its entry finds nothing.
    assert.equal(markStoreReadCancelled("renderer-b-1"), false);
  });

  it("reports no cancellation outside any op", () => {
    assert.equal(isStoreReadCancelled(), false);
  });
});

describe("ISS-9802: the token crosses every hop, and is omitted when absent", () => {
  it("forwards the token from the invoke dispatch to the store thread", async () => {
    const seen: { op: string; token: string | undefined }[] = [];
    const deps = invokeDepsDouble((op, _args, token) => {
      seen.push({ op, token });
      return Promise.resolve("value");
    });

    await dispatchDbHostInvoke("syncSource.aggregateAnalytics", [{}], deps, {
      cancellationToken: "renderer-c-1",
    });
    await dispatchDbHostInvoke("syncSource.aggregateAnalytics", [{}], deps);

    assert.deepEqual(seen, [
      { op: "syncSource.aggregateAnalytics", token: "renderer-c-1" },
      // Absent, not `undefined`-as-a-value: an uncancellable op is dispatched
      // exactly as it was before this change.
      { op: "syncSource.aggregateAnalytics", token: undefined },
    ]);
  });

  it("omits the field from the Execute message when there is no token", () => {
    const { worker, client } = storeClientHarness();

    client.execute("syncSource.aggregateAnalytics", [{}]);
    client.execute("syncSource.aggregateAnalytics", [{}], "renderer-c-2");

    const [plain, tokened] = worker.sent.filter(
      (message) => message.kind === DbStoreRequestKind.Execute
    );
    assert.ok(plain && !Object.hasOwn(plain, "cancellationToken"));
    assert.equal(
      tokened && "cancellationToken" in tokened
        ? tokened.cancellationToken
        : undefined,
      "renderer-c-2"
    );
  });

  it("posts a CancelRead the store thread can recognize", () => {
    const { worker, client } = storeClientHarness();

    client.cancelRead("renderer-c-3");

    const sent = worker.sent.at(-1);
    assert.deepEqual(sent, {
      kind: DbStoreRequestKind.CancelRead,
      token: "renderer-c-3",
    });
    assert.ok(isDbStoreRequest(sent));
  });
});

describe("ISS-9802: a version-skewed peer is unaffected", () => {
  it("accepts the new kinds and still accepts the old shapes", () => {
    // Both guards must admit the new kind, or the message is dropped before any
    // handler sees it — the cancel would silently do nothing.
    assert.ok(
      isDbHostRequest({
        kind: DbHostRequestKind.CancelRead,
        token: "renderer-d-1",
      })
    );
    assert.ok(
      isDbStoreRequest({
        kind: DbStoreRequestKind.CancelRead,
        token: "renderer-d-1",
      })
    );
    // An older peer's Invoke/Execute — no token field at all — is still a valid
    // request, which is what makes the field additive rather than required.
    assert.ok(
      isDbHostRequest({
        kind: DbHostRequestKind.Invoke,
        id: 1,
        op: "sessions.count",
        args: [],
      } satisfies DbHostRequest)
    );
    assert.ok(
      isDbStoreRequest({
        kind: DbStoreRequestKind.Execute,
        id: 1,
        op: "sessions.count",
        args: [],
      } satisfies DbStoreRequest)
    );
  });

  it("ignores a cancellation kind it has never heard of", () => {
    // The shape an OLDER child receives from a newer main: its guard refuses the
    // unknown kind, so the message is dropped and the read simply runs to
    // completion — today's behaviour, never a crash.
    assert.equal(
      isDbHostRequest({ kind: "cancel-read-v2", token: "x" }),
      false
    );
    assert.equal(
      isDbStoreRequest({ kind: "store-cancel-read-v2", token: "x" }),
      false
    );
  });
});

describe("ISS-9802: the store worker is wired to the registry", () => {
  it("binds each execute to its token and honours CancelRead", () => {
    // `db-store-worker.ts` registers a `parentPort` listener at module load, so
    // no test can import it and drive `handleRequest`. This is the same narrow
    // WIRING guard `db-host-invoke-dispatch.test.ts` keeps for the same module,
    // over the AST rather than the source text: the behaviour itself is executed
    // by every test above, against the real registry this file names.
    const called = calledFunctionNames(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../src/main/database/db-host/db-store-worker.ts"
      )
    );

    assert.ok(
      called.has("runStoreReadUnderCancellation"),
      "the store worker must bind an Execute to its cancellation token, or a cancel reaches no scope"
    );
    assert.ok(
      called.has("markStoreReadCancelled"),
      "the store worker must honour CancelRead, or the token is registered and never set"
    );
  });
});

describe("ISS-9802: one token can name several in-flight ops", () => {
  it("cancels BOTH halves of a page-data read, not just the last to start", async () => {
    // The production shape: `getSharedAgentSessionsPageData` fans ONE renderer
    // read out into `Promise.allSettled([list, usage])`, so two Executes arrive
    // over here under the same token. A registry keyed one-state-per-token would
    // let the second REPLACE the first, and the survivor would run its whole
    // scan while the source advertises that it cancels.
    const token = "renderer-page-data-1";
    let listStatements = 0;
    let usageStatements = 0;

    const list = runStoreReadUnderCancellation(token, async () => {
      for (let index = 0; index < YIELDS_PER_OP; index += 1) {
        listStatements += 1;
        await yieldDbHostLoop();
      }
    });
    const usage = runStoreReadUnderCancellation(token, async () => {
      for (let index = 0; index < YIELDS_PER_OP; index += 1) {
        usageStatements += 1;
        await yieldDbHostLoop();
      }
    });
    markStoreReadCancelled(token);

    await assert.rejects(list);
    await assert.rejects(usage);
    assert.ok(
      listStatements < YIELDS_PER_OP,
      `list half ran ${listStatements} of ${YIELDS_PER_OP} statements`
    );
    assert.ok(
      usageStatements < YIELDS_PER_OP,
      `usage half ran ${usageStatements} of ${YIELDS_PER_OP} statements`
    );
  });
});

describe("ISS-9802: cancellation abandons reads, never writes", () => {
  it("completes a write the cancelled read enqueued", async () => {
    // The real queue, because the defect is in how IT starts a task: `pump`
    // selects the next one from inside the previous task's settle continuation,
    // so `AsyncLocalStorage` carries the enqueuing read's scope into work that
    // belongs to somebody else. Losing a local write is worse than paying for a
    // scan, so this is the assertion that matters most in the file.
    const queue = createWriteQueue();
    const token = "renderer-write-safety-1";
    let write: Promise<string> | null = null;

    await assert.rejects(
      runStoreReadUnderCancellation(token, async () => {
        write = queue.run(async () => {
          await yieldDbHostLoop();
          return "written";
        });
        markStoreReadCancelled(token);
        await yieldDbHostLoop();
        return "read-completed";
      })
    );

    assert.ok(write, "the read must have enqueued a write");
    assert.equal(await write, "written");
  });
});

describe("ISS-9802: an abort that outruns its own read", () => {
  it("honours a cancel that arrived before the op registered", async () => {
    // TanStack Query aborts on unmount, which routinely lands while the read is
    // still crossing renderer -> main -> child -> store thread. Dropping that
    // abort would leave the commonest case paying for the whole scan.
    const token = "renderer-early-abort-1";
    let statements = 0;
    markStoreReadCancelled(token);

    await assert.rejects(
      runStoreReadUnderCancellation(token, async () => {
        for (let index = 0; index < YIELDS_PER_OP; index += 1) {
          statements += 1;
          await yieldDbHostLoop();
        }
      }),
      (error: Error) => {
        assert.equal(error.name, READ_CANCELLED_ERROR_NAME);
        return true;
      }
    );
    assert.equal(statements, 1);
  });
});

describe("ISS-9802: a cancelled read answers 'unknown', never a zero", () => {
  it("survives the clone boundary and rejects rather than resolving data", () => {
    // The sentinel crosses a structured clone, so recognition must be structural
    // — a referential check would pass in-process and fail in production.
    const cloned: unknown = structuredClone(DESKTOP_READ_CANCELLED_RESULT);

    assert.ok(isDesktopReadCancelledResult(cloned));
    assert.throws(() => rejectIfReadCancelled(cloned));
    // It carries NO payload field, so it can never be read as an answer: an
    // empty aggregate is indistinguishable from a real one, and a `0` cost is
    // the plausible-but-wrong number this shape exists to avoid.
    assert.deepEqual(Object.keys(DESKTOP_READ_CANCELLED_RESULT), ["status"]);
    // A real payload passes through untouched.
    assert.deepEqual(rejectIfReadCancelled({ totalSessions: 3 }), {
      totalSessions: 3,
    });
  });
});

describe("ISS-9802: a cancelled analytics read never answers zero", () => {
  it("rejects from the REAL aggregate instead of degrading to an empty one", async () => {
    // The production path, against a real SQLite file — because the defect this
    // pins is invisible to a synthetic op. `aggregateAnalytics` wraps the scan in
    // a catch (since ISS-10606 it rejects every failure, sanitized), and a catch
    // that swallowed the cancellation would make the read RESOLVE with an empty
    // aggregate, indistinguishable from a real one, so the Sessions surface
    // would render a confident "0 sessions / $0.00" for a window the user merely
    // navigated away from. Every earlier test in this file uses a synthetic op
    // body and cannot see that.
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss-9802-cancel-"));
    try {
      const db = await openSqliteAgentDatabase({
        dataDir: path.join(dir, "agent-dashboard.pgdata"),
        detectBillingMode: () => "api",
      });
      const source = createSqliteSessionSyncSource(db.prisma);
      // Captured before the closure: `aggregateAnalytics` is OPTIONAL on the
      // source type, and narrowing it by assertion does not survive into a
      // nested arrow.
      const aggregateAnalytics = source.aggregateAnalytics;
      assert.ok(aggregateAnalytics, "the sqlite source must aggregate");
      const token = "renderer-real-aggregate-1";
      // Cancelled before it starts, so the FIRST checkpoint inside the scan
      // throws — no clock, no race, no sleep.
      markStoreReadCancelled(token);

      await assert.rejects(
        runStoreReadUnderCancellation(token, async () =>
          aggregateAnalytics({}, createSessionAttributionResolverCache())
        ),
        (error: Error) => {
          assert.equal(error.name, READ_CANCELLED_ERROR_NAME);
          return true;
        }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function invokeDepsDouble(
  runOnStore: (
    op: string,
    args: unknown[],
    cancellationToken?: string
  ) => Promise<unknown>
): DbHostInvokeDeps {
  return {
    lanes: createDbHostOpLanes(),
    isOpen: () => true,
    runOnStore,
    probeUndispatchedWrite: () => {
      throw new Error("not used");
    },
    getInsights: (_args, compute) => compute(() => undefined),
    deliver: () => {
      // The delivered value is not what this test reads; the token is.
    },
  };
}

type FakeStoreWorker = DbStoreWorkerHandle & { sent: DbStoreRequest[] };

function storeClientHarness(): {
  worker: FakeStoreWorker;
  client: ReturnType<typeof createDbStoreClient>;
} {
  const worker: FakeStoreWorker = {
    sent: [],
    on() {
      return worker;
    },
    postMessage(message: DbStoreRequest) {
      worker.sent.push(message);
    },
    terminate() {
      return Promise.resolve(0);
    },
  } as FakeStoreWorker;
  const client = createDbStoreClient({
    onEmit: () => undefined,
    onSessionTerminal: () => undefined,
    onCommittedWrite: () => undefined,
    onWriteTask: () => undefined,
    onLog: () => undefined,
    onDurableLog: () => undefined,
    onTelemetry: () => undefined,
    onDeath: () => undefined,
    createWorker: () => worker,
    // Never fires: every assertion here reads the posted message synchronously.
    setTimeoutFn: (() => 0) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => undefined) as unknown as typeof clearTimeout,
  });
  return { worker, client };
}

/**
 * Every function name called anywhere in a module, read off its AST.
 *
 * Property-access calls count: the store worker reaches the registry through a
 * DYNAMIC import (its header forbids a static one), so both calls it makes are
 * `cancellation.<name>(…)` rather than bare identifiers. A walk that saw only
 * identifiers would report this wiring as absent — and, worse, would report it
 * as absent no matter how the worker was written.
 */
function calledFunctionNames(filePath: string): ReadonlySet<string> {
  const source = createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
  const names = new Set<string>();
  const walk = (node: Node): void => {
    if (isCallExpression(node)) {
      if (isIdentifier(node.expression)) {
        names.add(node.expression.text);
      }
      if (isPropertyAccessExpression(node.expression)) {
        names.add(node.expression.name.text);
      }
    }
    forEachChild(node, walk);
  };
  forEachChild(source, walk);
  return names;
}

describe("ISS-9802: the token bound is on BYTES, not only on entries", () => {
  it("refuses an over-long token at the shared validator", () => {
    // whitlockk review: a COUNT cap bounds entries, not memory. The pre-cancel ring
    // retains the token STRING, so 64 megabyte-long tokens sit inside a 64-entry
    // cap and still pin unbounded memory on the store thread. The length bound
    // is what makes that cap a real one.
    const real = `${Date.now().toString(36)}-abcdefgh-1`;
    assert.equal(isReadCancellationToken(real), true);
    assert.equal(readCancellationTokenOf({ cancellationToken: real }), real);

    const oversized = "x".repeat(READ_CANCELLATION_TOKEN_MAX_LENGTH + 1);
    assert.equal(isReadCancellationToken(oversized), false);
    // Treated as ABSENT, never as an error: a malformed cancellation costs the
    // caller its cancellation, never its answer. So the read still runs — it is
    // simply uncancellable, exactly as it was before this ticket.
    assert.equal(
      readCancellationTokenOf({ cancellationToken: oversized }),
      undefined
    );
    // The bound is INCLUSIVE, so a token exactly at the cap is still a token.
    assert.equal(
      isReadCancellationToken("x".repeat(READ_CANCELLATION_TOKEN_MAX_LENGTH)),
      true
    );
  });
});

describe("ISS-9802: a cancelled token binds the siblings that start LATER", () => {
  it("cancels a sibling admitted after the abort, not only what was in flight", async () => {
    // whitlockk/codex review: `pageData` fans up to four `aggregateUsage` invokes
    // through a lane that admits TWO at a time, so an abort routinely lands
    // while only the first pair is registered. Keeping the verdict solely on
    // those states let the queued siblings register fresh and run their scans in
    // full — the source advertising a cancellation that stopped nothing.
    const token = "renderer-lane-queued-1";
    let activeStatements = 0;
    let queuedStatements = 0;

    const active = runStoreReadUnderCancellation(token, async () => {
      for (let index = 0; index < YIELDS_PER_OP; index += 1) {
        activeStatements += 1;
        await yieldDbHostLoop();
      }
    });
    // The abort arrives while ONLY the first op is registered — it reaches a
    // live state, which is the branch that used to record nothing.
    assert.equal(markStoreReadCancelled(token), true);
    await assert.rejects(active);

    // The permit frees and the queued sibling starts, under the SAME token.
    const queued = runStoreReadUnderCancellation(token, async () => {
      for (let index = 0; index < YIELDS_PER_OP; index += 1) {
        queuedStatements += 1;
        await yieldDbHostLoop();
      }
    });

    await assert.rejects(queued, (error: Error) => {
      assert.equal(error.name, READ_CANCELLED_ERROR_NAME);
      return true;
    });
    assert.ok(
      queuedStatements < YIELDS_PER_OP,
      `queued sibling ran ${queuedStatements} of ${YIELDS_PER_OP} statements`
    );
    assert.ok(
      activeStatements < YIELDS_PER_OP,
      `active op ran ${activeStatements} of ${YIELDS_PER_OP} statements`
    );
  });
});

describe("ISS-9802: a cancelled usage read never pays for the whole scan", () => {
  it("rejects from the REAL usage aggregate at its first checkpoint", async () => {
    // whitlockk review: this read was handed a token and given no checkpoint to
    // observe it, so a CancelRead sat unread until all six statements had
    // finished — and `pageData` waits on this half. Driven against a real SQLite
    // file for the same reason the analytics case is: a synthetic op body cannot
    // see whether the PRODUCTION aggregate yields.
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss-9802-usage-"));
    try {
      const db = await openSqliteAgentDatabase({
        dataDir: path.join(dir, "agent-dashboard.pgdata"),
        detectBillingMode: () => "api",
      });
      const source = createSqliteSessionSyncSource(db.prisma);
      // Captured before the closure: `aggregateUsage` is OPTIONAL on the source
      // type, and narrowing it by assertion does not survive into a nested arrow.
      const aggregateUsage = source.aggregateUsage;
      assert.ok(aggregateUsage, "the sqlite source must aggregate usage");
      const token = "renderer-real-usage-1";
      // Cancelled before it starts, so the FIRST checkpoint inside the scan
      // throws — no clock, no race, no sleep.
      markStoreReadCancelled(token);

      await assert.rejects(
        runStoreReadUnderCancellation(token, async () => aggregateUsage({})),
        (error: Error) => {
          assert.equal(error.name, READ_CANCELLED_ERROR_NAME);
          return true;
        }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ISS-9802: an abort that lands while there is no child", () => {
  it("refuses the deferred invoke instead of re-running it on the replacement", async () => {
    // whitlockk/codex review: a signalled read parked on `DbHostClient.ready` during
    // the crash-ladder backoff still holds its token, but `cancelRead` had no
    // child to post to and DROPPED the abort. The ISS-5808 redrive then issued
    // the same read to the replacement, which had never heard of the cancel, so
    // it re-ran the expensive scan the user had already abandoned.
    const posted: DbHostRequest[] = [];
    let messageListener: DbHostChildMessageListener | undefined;
    const child = {
      stderr: null,
      on(...args: DbHostChildListenerArgs): unknown {
        if (args[0] === "message") {
          messageListener = args[1];
        }
        return child;
      },
      postMessage(message: DbHostRequest) {
        posted.push(message);
      },
      kill() {
        // no-op for the fake
      },
    };
    const client = new DbHostClient({
      onEmit: () => undefined,
      onLog: () => undefined,
      fork: () => child,
    });

    const token = "renderer-restart-gap-1";
    // The abort lands while the client has NO child: nothing can be posted, so
    // the verdict has to be retained on this side.
    client.cancelRead(token);
    assert.equal(
      posted.some((message) => message.kind === DbHostRequestKind.CancelRead),
      false,
      "there is no child to post a CancelRead to in this window"
    );

    // The replacement child comes up and `ready` settles.
    const started = client.start({ dataDir: "/tmp/agent-dashboard" });
    messageListener?.({
      kind: DbHostResponseKind.Ready,
      id: posted.find((message) => message.kind === DbHostRequestKind.Init)?.id,
    });
    await started;
    const postedAfterStart = posted.length;

    await assert.rejects(
      runWithReadCancellationToken(token, () =>
        client.invoke("sessions.aggregateUsage", [])
      ),
      (error: Error) => {
        assert.equal(error.name, READ_CANCELLED_ERROR_NAME);
        return true;
      }
    );
    // THE decisive assertion: the abandoned scan never reached the replacement.
    // A test that only watched the promise reject would pass while the child ran
    // the read to completion behind it.
    assert.equal(
      posted.length,
      postedAfterStart,
      "a cancelled read must not be issued to the replacement child"
    );

    // Positive control on the SAME selector: an uncancelled token still posts
    // its Invoke, so the assertion above is about the cancellation and not about
    // a client that stopped posting anything.
    const live = runWithReadCancellationToken("renderer-restart-gap-2", () =>
      client.invoke("sessions.aggregateUsage", [])
    );
    // `invoke` posts from its `ready.then(…)` continuation, so the Invoke is not
    // on the wire until the microtask queue drains. Yielding the turn is not a
    // timing assertion — nothing here waits for a DURATION.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(posted.length, postedAfterStart + 1);
    const issued = posted.at(-1);
    assert.equal(issued?.kind, DbHostRequestKind.Invoke);
    messageListener?.({
      kind: DbHostResponseKind.Result,
      id: issued && "id" in issued ? issued.id : undefined,
      ok: true,
      value: null,
    });
    assert.equal(await live, null);
  });
});

describe("ISS-9802: a cancelled usage half is not a usage FAILURE", () => {
  it("re-throws the cancellation instead of degrading it to usageError", async () => {
    // whitlockk review, second half. Now that `aggregateSqliteUsage` yields, the
    // usage half CAN reject with a cancellation — and `getSharedAgentSessionsPageData`
    // degrades a rejected usage half to `usageError: true`. Degrading a
    // cancellation would put the summary cards into an error state for a read
    // the CALLER superseded. The list half already re-throws; so does this one.
    //
    // Lives here rather than beside the `usageError` tests in
    // shared-agent-sessions-api.test.ts because that file is grandfathered
    // shrink-only; this is the ISS-9802 suite and the contract is ISS-9802's.
    const cancelledSource = createFakeSource({
      cursorRows: [cursor("session-a"), cursor("session-b")],
      aggregateUsage: () => {
        throw new DesktopReadCancelledError();
      },
    });

    await assert.rejects(
      getSharedAgentSessionsPageData(cancelledSource, { limit: 25 }),
      (error: Error) => {
        assert.equal(error.name, READ_CANCELLED_ERROR_NAME);
        return true;
      }
    );

    // Positive control on the SAME selector: an ordinary usage failure still
    // degrades, so the re-throw above is about cancellation and not about this
    // read having stopped tolerating a failing usage half.
    const failingSource = createFakeSource({
      cursorRows: [cursor("session-a"), cursor("session-b")],
      aggregateUsage: () => {
        throw new Error("usage aggregate failed");
      },
    });
    const degraded = await getSharedAgentSessionsPageData(failingSource, {
      limit: 25,
    });

    assert.equal(degraded.list.total, 2);
    assert.equal(degraded.usageError, true);
  });
});
