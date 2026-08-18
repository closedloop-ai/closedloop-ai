/**
 * @file db-host-client-clone-safe-post.test.ts
 * @description ISS-4620 — `DbHostClient.post` fail-safe.
 *
 * `child.postMessage` (structured clone) THROWS synchronously when a request
 * carries a non-cloneable payload. Before this fix that throw escaped the
 * `new Promise` executor in invoke() as an UNHANDLED rejection and popped the
 * fatal "unexpected error" dialog on the initial dashboard-load path. The
 * fail-safe wrapper catches the clone failure and rejects the request's OWN
 * correlated pending promise with the typed {@link DbHostDataCloneError}, so the
 * caller's existing `.catch`/degrade path handles it and the app keeps running.
 *
 * These tests drive the real `DbHostClient` with a fake forked child whose
 * `postMessage` throws a DataCloneError for a targeted op, and assert:
 *   1. `invoke()` rejects with the typed `DbHostDataCloneError` (not an
 *      unhandled throw), carrying the offending op.
 *   2. the pending map is cleaned up (no leaked correlation entry).
 *   3. a clone failure on one op does NOT tear down the client — a subsequent,
 *      clone-safe invoke still resolves.
 *
 * MUTATION: removing the try/catch in `post` turns leg 1's caught rejection back
 * into a synchronous throw out of the executor (an unhandled rejection), which
 * this test would surface as an assertion failure on the awaited rejection.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  DB_HOST_DATA_CLONE_ERROR_NAME,
  DbHostRequestKind,
  DbHostResponseKind,
  isDbHostDataCloneError,
} from "../src/main/database/db-host/db-host-protocol.js";
import type {
  ScheduledReviewRequest,
  ScheduledReviewResult,
} from "../src/shared/scheduled-review-contract.js";
import type {
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";

/** The offending op must surface in the typed clone-error message. */
const ADVANCE_SYNC_STATE_OP_RE = /syncSource\.advanceSyncState/;

/** The DataCloneError shape Electron's postMessage throws. */
function makeDataCloneError(): Error {
  const error = new Error("An object could not be cloned.");
  error.name = "DataCloneError";
  return error;
}

/**
 * A fake forked db-host child. `throwCloneOnOp`, when set, makes `postMessage`
 * throw a DataCloneError for an Invoke request whose op matches — modelling a
 * non-cloneable payload — while every other request posts normally.
 */
function makeFakeChild(throwCloneOnOp?: string, throwCloneOnKind?: string) {
  const posted: { kind: string; id?: number; op?: string }[] = [];
  let messageListener: DbHostChildMessageListener | undefined;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "message") {
        messageListener = args[1];
      }
      return child;
    },
    postMessage(message: { kind: string; id?: number; op?: string }) {
      if (
        throwCloneOnOp &&
        message.kind === DbHostRequestKind.Invoke &&
        message.op === throwCloneOnOp
      ) {
        throw makeDataCloneError();
      }
      // Model a non-cloneable payload on a non-Invoke request kind (e.g. a
      // ScheduledReviewResult whose value/error cannot be structured-cloned).
      if (throwCloneOnKind && message.kind === throwCloneOnKind) {
        throw makeDataCloneError();
      }
      posted.push(message);
    },
    kill() {
      // no-op for the fake
    },
  };
  return {
    child,
    posted,
    ready() {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({ kind: DbHostResponseKind.Ready, id: initId });
    },
    resolveLastInvoke(value: unknown) {
      const invokeId = posted
        .filter((m) => m.kind === DbHostRequestKind.Invoke)
        .at(-1)?.id;
      messageListener?.({
        kind: DbHostResponseKind.Result,
        id: invokeId,
        ok: true,
        value,
      });
    },
    /** Deliver an arbitrary child→main message (e.g. a ScheduledReviewRun). */
    emit(message: unknown) {
      messageListener?.(message);
    },
  };
}

type FakeChild = ReturnType<typeof makeFakeChild>;

/**
 * invoke() only posts to the child after its `ready` promise settles (a few
 * microtask hops). Wait on the OBSERVABLE posted Invoke count rather than
 * counting hops. THROWS when the bound is exhausted (no silent fall-through, per
 * the test:node determinism rules) so a regression that never posts fails fast
 * instead of hanging on the resolve that follows.
 */
async function waitForInvokeCount(
  fake: FakeChild,
  count: number,
  maxTurns = 50
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    const posted = fake.posted.filter(
      (m) => m.kind === DbHostRequestKind.Invoke
    ).length;
    if (posted >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(
    `expected ${count} posted invoke(s) within the microtask bound; the client never posted them`
  );
}

/** Build a started client over a supplied fake child, resolving its init. */
async function startClientOver(
  fake: FakeChild,
  onRunScheduledReview?: (
    request: ScheduledReviewRequest
  ) => Promise<ScheduledReviewResult>
): Promise<{
  client: DbHostClient;
  logs: string[];
}> {
  const logs: string[] = [];
  const client = new DbHostClient({
    onEmit: () => undefined,
    onLog: (message) => logs.push(message),
    onRunScheduledReview,
    fork: () => fake.child,
  });
  const started = client.start({ dataDir: "/tmp/agent-dashboard" });
  fake.ready();
  await started;
  return { client, logs };
}

test("invoke() rejects with a typed DbHostDataCloneError when postMessage throws (no unhandled rejection)", async () => {
  const fake = makeFakeChild("syncSource.advanceSyncState");
  const { client } = await startClientOver(fake);

  const rejected = await client
    .invoke("syncSource.advanceSyncState", ["src", { bad: () => undefined }])
    .then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const
    );

  assert.equal(rejected.ok, false, "the clone failure must reject the invoke");
  assert.ok(
    rejected.ok === false && isDbHostDataCloneError(rejected.error),
    "the rejection must be the typed DbHostDataCloneError"
  );
  const error = rejected.ok === false ? (rejected.error as Error) : null;
  assert.equal(error?.name, DB_HOST_DATA_CLONE_ERROR_NAME);
  assert.match(String(error?.message), ADVANCE_SYNC_STATE_OP_RE);
});

test("a clone failure does not tear down the client — a later clone-safe invoke still resolves", async () => {
  const fake = makeFakeChild("syncSource.advanceSyncState");
  const { client } = await startClientOver(fake);

  await client
    .invoke("syncSource.advanceSyncState", ["src", { bad: () => undefined }])
    .catch(() => undefined);

  // The failed invoke threw in postMessage, so it was never `posted`; the
  // clone-safe follow-up is the first posted invoke.
  const next = client.invoke("sessions.count", []);
  await waitForInvokeCount(fake, 1);
  fake.resolveLastInvoke(42);
  assert.equal(await next, 42);
});

test("pending correlation is cleaned up after a clone failure (no leaked entry)", async () => {
  const fake = makeFakeChild("importer.importSession");
  const { client } = await startClientOver(fake);

  // Baseline: no correlated requests are outstanding once init has resolved.
  assert.equal(
    client.pendingRequestCount,
    0,
    "no pending entries should remain after start()"
  );

  await client
    .invoke("importer.importSession", [{ method: () => undefined }])
    .catch(() => undefined);

  // TEETH: the failed invoke's pending entry must be DELETED, not left dangling.
  // This assertion fails if `handlePostFailure` stops calling `pending.delete(id)`
  // — the leaked entry would keep the count at 1 (the prior "next invoke uses a
  // new id" proxy could not catch that leak).
  assert.equal(
    client.pendingRequestCount,
    0,
    "the clone-failed invoke must not leave a leaked pending entry"
  );

  // And a fresh invoke still correlates correctly (a leaked stale entry would
  // otherwise mis-correlate the next Result id).
  const next = client.invoke("sessions.getAll", []);
  await waitForInvokeCount(fake, 1);
  fake.resolveLastInvoke(["row"]);
  assert.deepEqual(await next, ["row"]);
  assert.equal(
    client.pendingRequestCount,
    0,
    "the resolved invoke must also clean up its pending entry"
  );
});

test("a ScheduledReviewResult clone failure never deletes/rejects a same-id in-flight invoke (ISS-4620 P2)", async () => {
  // The worker mints ScheduledReview reverse-RPC ids from its OWN counter, so a
  // reply id can collide with a live main-side Invoke id. If posting that reply's
  // ScheduledReviewResult throws a DataCloneError, the failure must NOT reach into
  // `this.pending` and delete/reject the unrelated Invoke that happens to share
  // the id. Make the fake throw on the ScheduledReviewResult post to force that
  // race deterministically.
  const fake = makeFakeChild(
    undefined,
    DbHostRequestKind.ScheduledReviewResult
  );
  const reviewResult: ScheduledReviewResult = {
    ok: true,
    created: 0,
    skipped: 0,
    failed: 0,
    summary: "noop",
    error: null,
  };
  const { client, logs } = await startClientOver(fake, () =>
    Promise.resolve(reviewResult)
  );

  // Start a real Invoke and capture the id it was assigned (Init took id 1, so
  // this Invoke is id 2). It stays pending awaiting a Result.
  const invokePromise = client.invoke("sessions.getAll", []);
  await waitForInvokeCount(fake, 1);
  const invokeId = fake.posted
    .filter((m) => m.kind === DbHostRequestKind.Invoke)
    .at(-1)?.id;
  assert.ok(
    invokeId !== undefined,
    "the invoke must have been posted with an id"
  );
  assert.equal(
    client.pendingRequestCount,
    1,
    "exactly the in-flight invoke should be pending"
  );

  // The child raises a ScheduledReviewRun whose reverse-RPC id COLLIDES with the
  // live invoke id. Its result-post throws a DataCloneError inside the client.
  const request: ScheduledReviewRequest = {
    repoDir: "/tmp/repo",
    characters: [],
  };
  fake.emit({
    kind: DbHostResponseKind.ScheduledReviewRun,
    id: invokeId,
    generation: "gen-1",
    request,
  });
  // Let onRunScheduledReview resolve and its (throwing) result-post run.
  await Promise.resolve();
  await Promise.resolve();

  // TEETH: the collided-id invoke must STILL be pending and resolvable — the
  // clone failure on the review reply must not have deleted/rejected it. With the
  // pre-fix generic lookup this entry would already be gone (count 0) and the
  // invoke rejected below.
  assert.equal(
    client.pendingRequestCount,
    1,
    "the same-id invoke must remain pending after the review-reply clone failure"
  );
  fake.resolveLastInvoke(["row"]);
  assert.deepEqual(
    await invokePromise,
    ["row"],
    "the same-id invoke must resolve normally, unaffected by the review-reply failure"
  );

  // The dropped review reply degraded to a log line (best-effort), not a crash.
  assert.ok(
    logs.some((line) => line.includes(DbHostRequestKind.ScheduledReviewResult)),
    "the un-cloneable review reply must be logged and degraded"
  );
});
