/**
 * @file db-host-scheduled-review-generation.test.ts
 * @description FEA-4143 (Tzqf1) — the reverse-RPC `id` for a proxied scheduled
 * review restarts at 1 with every forked DB-host worker, but a reply can travel
 * through whatever child the transport owns at delivery time (an audit can
 * outlive a worker crash). Scoping the reverse RPC to a per-worker `generation`
 * is what stops a stale result cross-talking into an unrelated same-`id` request
 * in the replacement worker.
 *
 * These tests pin the MAIN side of that contract on the real `DbHostClient`:
 * main is stateless w.r.t. the generation and must echo the originating worker's
 * token back verbatim on the reply (so the child can drop a result that isn't
 * its own). We drive the client with an injected fake fork, feed it a
 * ScheduledReviewRun, and assert the reply it posts back.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  type DbHostRequest,
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import type {
  ScheduledReviewRequest,
  ScheduledReviewResult,
} from "../src/shared/scheduled-review-contract.js";
import type {
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";

const CLEAN_RESULT: ScheduledReviewResult = {
  ok: true,
  created: 1,
  skipped: 0,
  failed: 0,
  summary: "1 issue(s) filed",
  error: null,
};

const REVIEW_REQUEST: ScheduledReviewRequest = {
  repoDir: "/repos/app",
  characters: ["docs-darwin"],
  projectSlug: "night-crew",
};

/** A fake forked child that captures the client's message listener + posts. */
function makeFakeChild() {
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
  return {
    child,
    posted,
    /** Deliver a child→main message through the client's registered listener. */
    emit(message: unknown) {
      messageListener?.(message);
    },
  };
}

test("main echoes the worker generation back verbatim on a scheduled-review reply (Tzqf1)", async () => {
  const fake = makeFakeChild();
  const runReview = () => Promise.resolve(CLEAN_RESULT);
  const client = new DbHostClient({
    onEmit: () => {},
    onLog: () => {},
    onRunScheduledReview: runReview,
    fork: () => fake.child,
  });
  // Kick a spawn so the client wires its message listener onto the fake child.
  // We do not await start (init never resolves without a Ready reply); the
  // listener is registered synchronously inside spawn(). Swallow the never-
  // resolving init promise so it does not surface as an unhandled rejection.
  client.start({ dataDir: "/tmp/db" }).catch(() => undefined);

  fake.emit({
    kind: DbHostResponseKind.ScheduledReviewRun,
    id: 1,
    generation: "worker-gen-A",
    request: REVIEW_REQUEST,
  });
  // Let the runReview microtask settle so the reply is posted.
  await new Promise((resolve) => setImmediate(resolve));

  const reply = fake.posted.find(
    (m) => m.kind === DbHostRequestKind.ScheduledReviewResult
  );
  assert.ok(reply, "main must post a ScheduledReviewResult reply");
  assert.equal(reply.kind, DbHostRequestKind.ScheduledReviewResult);
  if (reply.kind !== DbHostRequestKind.ScheduledReviewResult) {
    return;
  }
  // The reply carries the ORIGINATING worker's generation, correlated `id`, and
  // the run value — so a re-forked worker can drop a foreign generation instead
  // of mis-resolving its own same-`id` review.
  assert.equal(reply.generation, "worker-gen-A");
  assert.equal(reply.id, 1);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.value, CLEAN_RESULT);
});

test("a failed scheduled review still echoes the originating generation (Tzqf1)", async () => {
  const fake = makeFakeChild();
  const client = new DbHostClient({
    onEmit: () => {},
    onLog: () => {},
    onRunScheduledReview: () => Promise.reject(new Error("audit exploded")),
    fork: () => fake.child,
  });
  client.start({ dataDir: "/tmp/db" }).catch(() => undefined);

  fake.emit({
    kind: DbHostResponseKind.ScheduledReviewRun,
    id: 7,
    generation: "worker-gen-B",
    request: REVIEW_REQUEST,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const reply = fake.posted.find(
    (m) => m.kind === DbHostRequestKind.ScheduledReviewResult
  );
  assert.ok(reply, "main must post a reply even on a runner failure");
  if (reply?.kind !== DbHostRequestKind.ScheduledReviewResult) {
    return;
  }
  assert.equal(reply.generation, "worker-gen-B");
  assert.equal(reply.id, 7);
  assert.equal(reply.ok, false);
  assert.equal(reply.error?.message, "audit exploded");
});
