/**
 * @file db-host-close-wiring.test.ts
 * @description ISS-6003 — the worker's `Close` case must actually DELEGATE to
 * `runDbHostCloseSequence`.
 *
 * `db-host-close-sequence.test.ts` pins the ORDER the helper imposes, but every
 * assertion there runs against the helper directly. Reverting `db-host-worker.ts`
 * to its inline close-then-profile body leaves that suite green and the helper
 * simply uncalled — which is the regression this issue fixed. The worker cannot
 * be imported by a test (it registers a `process.parentPort` listener at load),
 * so this reads its AST, the same guard `db-host-invoke-dispatch.test.ts` and
 * `post-boot-maintenance-skill-inventory-order.test.ts` already apply to this
 * exact file for this exact reason.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Node } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { describe, test } from "vitest";

const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/database/db-host/db-host-worker.ts"
);

/** Free-function calls made inside the worker's `handleMessage`, in order. */
function readCallsInHandleMessage(): string[] {
  const source = createSourceFile(
    WORKER_PATH,
    readFileSync(WORKER_PATH, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
  let handleMessage: Node | undefined;
  forEachChild(source, (node) => {
    if (
      isFunctionDeclaration(node) &&
      node.name?.getText(source) === "handleMessage"
    ) {
      handleMessage = node;
    }
  });
  if (!handleMessage) {
    throw new Error("handleMessage not found in db-host-worker.ts");
  }
  const calls: string[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node) && isIdentifier(node.expression)) {
      calls.push(node.expression.getText(source));
    }
    forEachChild(node, visit);
  };
  forEachChild(handleMessage, visit);
  return calls;
}

/** EVERY call in `handleMessage`, free-function and method alike, in order. */
function readEveryCallInHandleMessage(): string[] {
  const source = createSourceFile(
    WORKER_PATH,
    readFileSync(WORKER_PATH, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
  let handleMessage: Node | undefined;
  forEachChild(source, (node) => {
    if (
      isFunctionDeclaration(node) &&
      node.name?.getText(source) === "handleMessage"
    ) {
      handleMessage = node;
    }
  });
  if (!handleMessage) {
    throw new Error("handleMessage not found in db-host-worker.ts");
  }
  const calls: string[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      calls.push(node.expression.getText(source));
    }
    forEachChild(node, visit);
  };
  forEachChild(handleMessage, visit);
  return calls;
}

describe("db-host worker Close wiring", () => {
  test("terminates the store thread before it acknowledges main", () => {
    // ISS-8246 M1 §1.7. The ack is main's signal that this host has reached the
    // shutdown point the single-process db-host used to reach. Emitting it while
    // a store thread is still live would make that signal false — main would
    // proceed to kill a process whose writer connection had not been released,
    // which is the un-drained-write corruption ISS-4713 removed.
    const calls = readEveryCallInHandleMessage();
    const terminateAt = calls.indexOf("storeClient?.terminate");
    assert.notEqual(
      terminateAt,
      -1,
      "the Close case must terminate the store thread — nothing else releases it, " +
        "and `process.exit` in the worker stops only that thread (ISS-8246 probe 8)"
    );
    const ackAt = calls.lastIndexOf("post");
    assert.ok(
      ackAt > terminateAt,
      "main's Close acknowledgement must follow the store thread's termination"
    );
  });

  test("delegates shutdown to runDbHostCloseSequence, before it exits", () => {
    const calls = readCallsInHandleMessage();
    const sequenceAt = calls.indexOf("runDbHostCloseSequence");
    assert.notEqual(
      sequenceAt,
      -1,
      "the worker must route its Close teardown through runDbHostCloseSequence, " +
        "not inline the store close and profile flush again"
    );
    const exitAt = calls.lastIndexOf("post");
    assert.ok(
      exitAt > sequenceAt,
      "the Close acknowledgement must follow the teardown, not precede it"
    );
  });
});
