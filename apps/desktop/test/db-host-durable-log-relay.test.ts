/**
 * @file db-host-durable-log-relay.test.ts
 * @description ISS-7882 — a durable warning written inside the DB-host child
 * reaches the operator's `main.log`.
 *
 * WHAT WAS BROKEN. `initializePersistentLogging` has one production call site,
 * `startup.ts`, which runs only in the main process. Inside the db-host
 * `utilityProcess` every `writePersistentLog` line was therefore taken by
 * `PreInitLogBuffer.capture` — whose `drain()` is reachable only from that
 * initializer — and never written anywhere, then dropped outright past the
 * 500-line cap. Six call sites reachable from that entry produced no trace at
 * all while their comments said the value was "surfaced on the durable
 * main-process log".
 *
 * WHY THE TEST HAS TO BE SHAPED LIKE THIS. One process cannot be both sides of
 * the relay, so the two roles are played in sequence and the ORDER is the
 * contract: with the child's sink installed, a production durable write must
 * reach the file NOT AT ALL until the message crosses to main. A test that only
 * asserted "the line is in main.log at the end" would pass with the relay
 * deleted, because this process has an initialized transport of its own — which
 * is precisely the false green the ticket is about. The relay is installed with
 * the REAL production factory (`createDbHostDurableLogRelay`) and the main half
 * is driven through the REAL `DbHostClient` message path, so neither end is a
 * re-implementation; `db-host-worker.ts` itself cannot be imported (it registers
 * a `process.parentPort` listener at load), so the third case reads its AST for
 * the install, the same guard `db-host-telemetry-relay-wiring.test.ts` applies to
 * that file for that reason.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, SourceFile } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import { createDbHostDurableLogRelay } from "../src/main/database/db-host/db-host-durable-log.js";
import {
  type DbHostDurableLogResponse,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { planSyncedSessionHydration } from "../src/main/database/synced-session-hydration-plan.js";
import {
  routeDurableLogsToSink,
  writeGatewayLogEntry,
  writePersistentLog,
} from "../src/main/logging/durable-log-sink.js";
import {
  electronLog,
  initializePersistentLogging,
} from "../src/main/logging/persistent-log.js";
import type {
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";

/**
 * The wording is pinned as a LITERAL rather than rebuilt from
 * `sizingDegradeMessage`. Deriving it would assert that a formatter equals
 * itself and would follow any edit straight through; the duplication is the
 * test. Same reasoning as `synced-session-hydration-durable-log.test.ts`.
 */
const RELAYED_LINE_RE =
  /\[warn]\s+\[sync-source] sync-source: hydration sizing read failed for 3 session\(s\); falling back to fixed 200-id chunks: reader unavailable/;
const EXPECTED_RELAYED_LINE =
  "[sync-source] sync-source: hydration sizing read failed for 3 session(s); falling back to fixed 200-id chunks: reader unavailable";
const RELAYED_GATEWAY_ENTRY_RE = /relayed gateway entry/;
const DEGRADED_COLUMN_RE = /degraded a column/;
const FORGED_LINE_COLLAPSED_RE = /first forged second line/;
const UNUSABLE_LEVEL_RE =
  /\[warn]\s+\[persistent-log] relayed line carried an unusable level \("catastrophe"\); recorded at warn/;
/** Hoisted per Ultracite `useTopLevelRegex`. */
const SHARED_RELAY_FACTORY_RE = /createDbHostDurableLogRelay\(/;
const KNOWN_ERROR_LEVEL_RE =
  /\[error]\s+\[sync-source] real error from the child/;
const UNUSABLE_LEVEL_NOTICE_RE = /unusable level/;
const QUOTED_LEVEL_RE = /unusable level \("([^"]*)"\)/;

const IDS = ["s0", "s1", "s2"];
const SIZING_READ_ERROR = "reader unavailable";

const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/database/db-host/db-host-worker.ts"
);

const logDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "db-host-durable-log-relay-")
);
const logPath = path.join(logDir, "main.log");
const originalLogPathResolver = electronLog.transports.file.resolvePathFn;

beforeAll(() => {
  // Stands in for MAIN's `startup.ts`: this process gets the one initialized
  // file transport, exactly as the main process has. The child role is played by
  // installing a relay sink, which is what a process with NO transport does.
  electronLog.transports.file.resolvePathFn = () => logPath;
  initializePersistentLogging();
});

afterEach(() => {
  routeDurableLogsToSink(null);
});

afterAll(() => {
  electronLog.transports.file.resolvePathFn = originalLogPathResolver;
  fs.rmSync(logDir, { force: true, recursive: true });
});

describe("ISS-7882: the db-host child's durable lines reach main.log", () => {
  test("with no relay installed the same production write lands locally", async () => {
    // The positive sibling for the case below, and the reason its "nothing
    // reached the file" assertion is not vacuous. Without it, a
    // `planSyncedSessionHydration` that had stopped writing durably at all —
    // or a broken fixture that never entered the degrade — would satisfy the
    // negative half perfectly.
    const offsetBefore = logByteLength();

    await planSyncedSessionHydration(
      failingPrisma(),
      IDS,
      { omitEventData: true },
      () => undefined
    );

    assert.match(
      logSince(offsetBefore),
      RELAYED_LINE_RE,
      "a process that owns a transport writes the degrade straight to it"
    );
  });

  test("a relayed warning reaches main.log only after crossing to main", async () => {
    const posted: DbHostDurableLogResponse[] = [];
    routeDurableLogsToSink(
      createDbHostDurableLogRelay({ post: (m) => posted.push(m) })
    );
    const offsetBefore = logByteLength();

    // The four-argument call `sync-source.ts` makes, with no injected seam, so
    // this is the real production shape reaching the real default.
    await planSyncedSessionHydration(
      failingPrisma(),
      IDS,
      { omitEventData: true },
      () => undefined
    );

    // THE DISCRIMINATOR. Delete the relay branch in `writeDurableLine`
    // (`logging/durable-log-sink.ts`) and this fails: the line lands in this
    // process's own transport instead of being handed to the sink, and the
    // whole relay is bypassed while the end-state assertion below would still
    // have gone green.
    assert.equal(
      logSince(offsetBefore),
      "",
      "a process with a relay must not also write the line locally"
    );
    assert.deepEqual(posted, [
      {
        kind: DbHostResponseKind.DurableLog,
        level: "warn",
        line: EXPECTED_RELAYED_LINE,
      },
    ]);

    // Now the main half. Drop the relay first: MAIN never installs one — that is
    // exactly what distinguishes the two roles this single process is playing in
    // sequence — and leaving it installed would bounce the delivered line
    // straight back into the sink instead of onto the file transport.
    routeDurableLogsToSink(null);
    // Through the REAL DbHostClient message path, not a re-implementation of it.
    deliverToMain(posted[0]);

    assert.match(
      logSince(offsetBefore),
      RELAYED_LINE_RE,
      "main appends the child's line to its own main.log, at the child's level"
    );
  });

  test("a relayed line with an unusable level is written at warn, never dropped", () => {
    // Code review (api-architect): refusing this message at the boundary would
    // drop it in SILENCE — `handleMessage` routes a refusal to
    // `reportRefusedChildTelemetry`, which returns early for every kind but
    // `telemetry`. So the boundary checks only `line`, and an unusable level is
    // degraded here and stated. Driven through the real `DbHostClient` path with
    // a level no build accepts.
    const offsetBefore = logByteLength();

    deliverToMain({
      kind: DbHostResponseKind.DurableLog,
      level: "catastrophe" as unknown as DbHostDurableLogResponse["level"],
      line: "[sync-source] degraded a column",
    });

    const written = logSince(offsetBefore);
    assert.match(
      written,
      UNUSABLE_LEVEL_RE,
      "the line must survive, at warn, saying its level was unusable"
    );
    assert.match(written, DEGRADED_COLUMN_RE);
  });

  test("a relayed line cannot forge a second log entry with a newline", () => {
    // Code review (auth-security-expert): a relayed line quotes runtime data, so
    // an embedded newline would append a line a reader cannot tell from a real
    // entry — and `parsePreviousSessionLogTail` splits on exactly that newline,
    // so the forgery would come back as a genuine previous-session record.
    const offsetBefore = logByteLength();

    deliverToMain({
      kind: DbHostResponseKind.DurableLog,
      level: "warn",
      line: "[sync-source] first\nforged second line",
    });

    const written = logSince(offsetBefore);
    assert.equal(
      written.trimEnd().split("\n").length,
      1,
      `one relayed message must occupy exactly one line; got ${JSON.stringify(written)}`
    );
    assert.match(
      written,
      FORGED_LINE_COLLAPSED_RE,
      "and the text is kept — the separator is neutralised, not the content"
    );
  });

  test("the seam sits at the funnel, so every durable writer in the child routes", () => {
    // ISS-7882 enumerated six `writePersistentLog` call sites reachable from the
    // db-host entry. Asserting them one by one would leave the SEVENTH — the one
    // added next week — silently unrelayed. Both public durable writers share one
    // private funnel, so proving the OTHER one routes proves the seam is at the
    // funnel and coverage is by construction rather than by list.
    const posted: DbHostDurableLogResponse[] = [];
    routeDurableLogsToSink(
      createDbHostDurableLogRelay({ post: (m) => posted.push(m) })
    );
    const offsetBefore = logByteLength();

    writeGatewayLogEntry({
      timestamp: "2026-08-24T00:00:00.000Z",
      level: "error",
      tag: "agent-sqlite",
      message: "relayed gateway entry",
    });

    assert.equal(logSince(offsetBefore), "");
    assert.equal(posted.length, 1);
    assert.equal(posted[0].level, "error");
    assert.match(posted[0].line, RELAYED_GATEWAY_ENTRY_RE);
  });

  test("the relay swallows a throwing post without affecting the caller", () => {
    const relay = createDbHostDurableLogRelay({
      post: () => {
        throw new Error("port gone");
      },
    });
    routeDurableLogsToSink(relay);
    const offsetBefore = logByteLength();

    assert.doesNotThrow(() =>
      writePersistentLog("warn", "scope", "line after port gone")
    );

    routeDurableLogsToSink(null);
    assert.equal(
      logSince(offsetBefore),
      "",
      "the relay consumed the line — it must not have leaked to the local transport"
    );
  });

  test("a relayed line with a known level keeps that level, not warn", () => {
    const offsetBefore = logByteLength();

    deliverToMain({
      kind: DbHostResponseKind.DurableLog,
      level: "error",
      line: "[sync-source] real error from the child",
    });

    const written = logSince(offsetBefore);
    assert.match(
      written,
      KNOWN_ERROR_LEVEL_RE,
      "a known level must pass through verbatim, not degrade to warn"
    );
    assert.doesNotMatch(
      written,
      UNUSABLE_LEVEL_NOTICE_RE,
      "a known level must not trigger the unusable-level prefix"
    );
  });

  test("an unusable level longer than 32 characters is truncated in the notice", () => {
    const longLevel = "x".repeat(4096);
    const offsetBefore = logByteLength();

    deliverToMain({
      kind: DbHostResponseKind.DurableLog,
      level: longLevel as unknown as DbHostDurableLogResponse["level"],
      line: "[sync-source] long level probe",
    });

    const written = logSince(offsetBefore);
    assert.match(
      written,
      UNUSABLE_LEVEL_NOTICE_RE,
      "a non-level string must trigger the unusable-level notice"
    );
    const quotedLevelMatch = written.match(QUOTED_LEVEL_RE);
    assert.ok(quotedLevelMatch, "the notice must quote the level");
    assert.equal(
      quotedLevelMatch[1].length,
      32,
      `the quoted level must be truncated to 32 characters, got ${quotedLevelMatch[1].length}`
    );
  });
});

describe("ISS-7882: the worker installs the relay", () => {
  test("installs it at module scope, built by the shared factory", () => {
    const install = readModuleScopeCalls(readWorkerSource()).find(
      ([callee]) => callee === "routeDurableLogsToSink"
    );
    assert.ok(
      install,
      "db-host-worker.ts must call routeDurableLogsToSink at MODULE SCOPE — " +
        "without it every durable line this process writes is buffered and never " +
        "drained, which is the whole of ISS-7882"
    );
    assert.match(
      install[1],
      SHARED_RELAY_FACTORY_RE,
      "the sink must be the shared factory, not a second inline post closure — " +
        "an inline one would not carry the factory's never-throw guarantee"
    );
  });

  test("installs it before any module-scope work that can log", () => {
    const calls = readTopLevelCallOrder(readWorkerSource());
    const installAt = calls.indexOf("routeDurableLogsToSink");
    assert.notEqual(installAt, -1);
    // Everything below the install can write durably — the crash logger, the
    // profiler, the op lanes, and through the Init request the whole store. The
    // install also replays what the IMPORTS above it buffered, so an install
    // moved below these would strand their lines rather than merely delaying them.
    for (const later of [
      "installProcessCrashLogging",
      "startDbHostProfiling",
      "createDbHostOpLanes",
    ]) {
      const laterAt = calls.indexOf(later);
      assert.notEqual(laterAt, -1, `${later} is no longer at module scope`);
      assert.ok(
        installAt < laterAt,
        `the durable-log relay must be installed before ${later} runs`
      );
    }
  });
});

/** A prisma whose sizing read always rejects — the degrade's entry condition. */
function failingPrisma(): DesktopPrisma {
  return {
    read: () => Promise.reject(new Error(SIZING_READ_ERROR)),
  } as unknown as DesktopPrisma;
}

/**
 * Hand one relayed message to the REAL main-side `DbHostClient` routing, over
 * its `fork` seam. Nothing here re-implements `handleMessage`: the client's own
 * message listener is what dispatches the `durable-log` case.
 */
function deliverToMain(message: DbHostDurableLogResponse): void {
  let messageListener: DbHostChildMessageListener | undefined;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "message") {
        messageListener = args[1];
      }
      return child;
    },
    postMessage() {
      // no-op for the fake
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
  // `start` registers the listener synchronously and then parks on Ready, which
  // never arrives here; the relay is an UNSOLICITED push and needs no boot.
  client.start({ dataDir: logDir }).catch(() => undefined);
  if (!messageListener) {
    throw new Error("DbHostClient did not register a message listener");
  }
  messageListener(message);
}

function logByteLength(): number {
  return fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
}

/**
 * The tail written since `offset`. A missing file is "" rather than a throw, so
 * a deleted durable call fails on the assertion instead of on ENOENT.
 */
function logSince(offset: number): string {
  return fs.existsSync(logPath)
    ? fs.readFileSync(logPath).subarray(offset).toString("utf8")
    : "";
}

function readWorkerSource(): SourceFile {
  return createSourceFile(
    WORKER_PATH,
    fs.readFileSync(WORKER_PATH, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
}

/** Top-level `foo(...)` statements, as `[callee, argument text]` pairs. */
function readModuleScopeCalls(source: SourceFile): [string, string][] {
  const calls: [string, string][] = [];
  for (const statement of source.statements) {
    if (!isExpressionStatement(statement)) {
      continue;
    }
    const call: Node = statement.expression;
    if (!(isCallExpression(call) && isIdentifier(call.expression))) {
      continue;
    }
    calls.push([
      call.expression.getText(source),
      call.arguments.map((argument) => argument.getText(source)).join(", "),
    ]);
  }
  return calls;
}

/**
 * Callee names of every identifier-called function that runs AT MODULE LOAD, in
 * source order — including inside `const x = f(...)` initialisers, which is the
 * form several of the ordered markers take.
 *
 * The walk stops at any function/arrow/method/class body. Without that it would
 * also report a call sitting INSIDE a callback, which does not run at module
 * load at all: an install deferred into `app.whenReady(() => …)` would keep its
 * source position and satisfy an order assertion it no longer honours.
 */
function readTopLevelCallOrder(source: SourceFile): string[] {
  const calls: string[] = [];
  const visit = (node: Node): void => {
    if (isDeferredBody(node)) {
      return;
    }
    if (isCallExpression(node) && isIdentifier(node.expression)) {
      calls.push(node.expression.getText(source));
    }
    forEachChild(node, visit);
  };
  for (const statement of source.statements) {
    visit(statement);
  }
  return calls;
}

/** A node whose contents run later (or never), not during module evaluation. */
function isDeferredBody(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node) ||
    isMethodDeclaration(node) ||
    isClassDeclaration(node)
  );
}
