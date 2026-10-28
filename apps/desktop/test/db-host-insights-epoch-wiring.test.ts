/**
 * @file db-host-insights-epoch-wiring.test.ts
 * @description ISS-7110 — a committed write must still advance the FEA-2055
 * insights epoch, now that the write and the cache are on different threads.
 *
 * `insights-epoch-committed-writes.test.ts` proves the store-side seam fires on
 * every committed write, but nothing there stops the wiring from simply not
 * being passed — which recreates the ISS-7110 bug exactly (an epoch that only
 * live-hook events advance, and a dashboard that re-serves pre-backfill empties
 * forever).
 *
 * ISS-8246 M1 split that wiring in two. `openSqliteAgentDatabase` now runs on
 * the store thread, where `insightsCache` does not exist, so `onCommittedWrite`
 * posts a message; the dispatcher owns the cache and applies the bump. BOTH ends
 * are pinned here, because either one alone is a green suite over a dead epoch:
 * a store that stops posting leaves the dispatcher's handler correct and never
 * called, and a dispatcher that stops bumping leaves the store's post correct
 * and ignored.
 *
 * The ORDERING half of the contract — that the bump is applied before the write's
 * own result reaches main — is executed, not scanned, in
 * `db-host-store-relay.test.ts`. This file only pins that the two ends are
 * connected at all, which no executed test can cover: neither module can be
 * imported (one registers a `process.parentPort` listener at load, the other
 * opens SQLite), so the connection is read from the AST — the same guard
 * `db-host-close-wiring.test.ts` applies to this exact file for this exact
 * reason.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, SourceFile } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isFunctionDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { test } from "vitest";

const DB_HOST_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/database/db-host"
);
const WORKER_PATH = path.join(DB_HOST_DIR, "db-host-worker.ts");
const STORE_HOST_PATH = path.join(DB_HOST_DIR, "db-store-host.ts");
const COMMITTED_WRITE_PROPERTY = "onCommittedWrite";

function parse(file: string): SourceFile {
  return createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
}

/** Dotted method calls (`a.b(...)`) anywhere under `root`. */
function methodCallsUnder(root: Node, source: SourceFile): string[] {
  const calls: string[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
      calls.push(node.expression.getText(source));
    }
    forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

/** Initializer source text of every `<name>:` property assignment in `source`. */
function propertyInitializers(source: SourceFile, name: string): string[] {
  const initializers: string[] = [];
  forEachChild(source, function visit(node: Node): void {
    if (isPropertyAssignment(node) && node.name.getText(source) === name) {
      initializers.push(node.initializer.getText(source));
    }
    forEachChild(node, visit);
  });
  return initializers;
}

/** Dotted method calls inside every `<name>:` property initializer in `source`. */
function callsUnderProperty(source: SourceFile, name: string): string[] {
  const calls: string[] = [];
  forEachChild(source, function visit(node: Node): void {
    if (isPropertyAssignment(node) && node.name.getText(source) === name) {
      calls.push(...methodCallsUnder(node.initializer, source));
    }
    forEachChild(node, visit);
  });
  return calls;
}

function findFunction(source: SourceFile, name: string): Node {
  let found: Node | undefined;
  forEachChild(source, (node) => {
    if (isFunctionDeclaration(node) && node.name?.getText(source) === name) {
      found = node;
    }
  });
  if (!found) {
    throw new Error(`${name} not found in ${source.fileName}`);
  }
  return found;
}

test("ISS-7110: the store thread posts a committed write to the dispatcher", () => {
  const source = parse(STORE_HOST_PATH);
  const initializers = propertyInitializers(source, COMMITTED_WRITE_PROPERTY);
  assert.notEqual(
    initializers.length,
    0,
    `openSqliteAgentDatabase must still be passed ${COMMITTED_WRITE_PROPERTY} on ` +
      "the store thread — without it, backfill and importer writes advance no epoch " +
      "at all and the ISS-7110 onboarding zeros come straight back"
  );
  assert.ok(
    callsUnderProperty(source, COMMITTED_WRITE_PROPERTY).includes("deps.post"),
    `${COMMITTED_WRITE_PROPERTY} must relay to the dispatcher — ` +
      "`process.parentPort` is undefined in a worker, so a bump that is not " +
      "posted reaches the insights cache by no other route (ISS-8246 M1)"
  );
});

test("ISS-7110: the dispatcher applies that bump to the insights cache", () => {
  const source = parse(WORKER_PATH);
  assert.ok(
    propertyInitializers(source, COMMITTED_WRITE_PROPERTY).includes(
      "handleCommittedWrite"
    ),
    `the dispatcher must hand its store client ${COMMITTED_WRITE_PROPERTY} — ` +
      "an unhandled relay message is silently dropped"
  );
  assert.ok(
    methodCallsUnder(
      findFunction(source, "handleCommittedWrite"),
      source
    ).includes("insightsCache.bumpDataEpoch"),
    "handleCommittedWrite must bump the FEA-2055 insights epoch — without it, " +
      "backfill/importer writes never invalidate the cache (ISS-7110)"
  );
});
