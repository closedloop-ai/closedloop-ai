import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  electronLog,
  parsePreviousSessionLogLine,
  parsePreviousSessionLogTail,
  readPreviousSessionLogTail,
  writeGatewayLogEntry,
} from "../src/main/persistent-log.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const { makeTempDir } = createTempDirManager("desktop-persistent-log-");

describe("persistent log tail parsing", () => {
  test("parses GatewayLogger JSON lines as previous-session entries", () => {
    const line = `closedloop-gateway-log ${JSON.stringify({
      timestamp: "2026-05-08T12:34:56.789Z",
      level: "error",
      tag: "shutdown",
      message: "hard-exit timeout reached",
      session: "current",
    })}`;

    assert.deepEqual(parsePreviousSessionLogLine(line), {
      timestamp: "2026-05-08T12:34:56.789Z",
      level: "error",
      tag: "shutdown",
      message: "hard-exit timeout reached",
      session: "previous",
    });
  });

  test("tolerates legacy or unparseable lines with a generic desktop row", () => {
    const parsed = parsePreviousSessionLogLine(
      "[2026-05-08 12:34:56.789] [info] autoUpdater: checking for update"
    );

    assert.equal(parsed.level, "info");
    assert.equal(parsed.tag, "desktop");
    assert.equal(parsed.message, "autoUpdater: checking for update");
    assert.equal(parsed.session, "previous");
  });

  test("reads a bounded tail from disk and returns [] for missing files", async () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "main.log");
    fs.writeFileSync(
      logPath,
      [
        "older",
        `closedloop-gateway-log ${JSON.stringify({
          timestamp: "2026-05-08T12:00:00.000Z",
          level: "info",
          tag: "startup",
          message: "boot",
        })}`,
        "newer",
      ].join("\n")
    );

    const entries = await readPreviousSessionLogTail(2, logPath);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].tag, "startup");
    assert.equal(entries[1].message, "newer");
    assert.deepEqual(
      await readPreviousSessionLogTail(2, path.join(dir, "missing.log")),
      []
    );
  });

  test("reads recent rows from large log files", async () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "main.log");
    const olderRows = Array.from(
      { length: 20_000 },
      (_value, index) => `older-${index}`
    ).join("\n");
    fs.writeFileSync(
      logPath,
      [
        olderRows,
        "recent-one",
        `closedloop-gateway-log ${JSON.stringify({
          timestamp: "2026-05-08T12:01:00.000Z",
          level: "warn",
          tag: "recent",
          message: "recent-two",
        })}`,
      ].join("\n")
    );

    const entries = await readPreviousSessionLogTail(2, logPath);

    assert.deepEqual(
      entries.map((entry) => entry.message),
      ["recent-one", "recent-two"]
    );
  });

  test("parsePreviousSessionLogTail keeps only the requested number of rows", () => {
    const entries = parsePreviousSessionLogTail("one\ntwo\nthree\n", 2);
    assert.deepEqual(
      entries.map((entry) => entry.message),
      ["two", "three"]
    );
  });

  test("writeGatewayLogEntry creates the file parent without electron-log console fallback", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "missing", "main.log");
    const originalResolvePathFn = electronLog.transports.file.resolvePathFn;
    const originalConsoleWriteFn = electronLog.transports.console.writeFn;
    let consoleWrites = 0;

    electronLog.transports.file.resolvePathFn = () => logPath;
    electronLog.transports.console.writeFn = () => {
      consoleWrites += 1;
    };

    try {
      writeGatewayLogEntry({
        timestamp: "2026-05-08T12:34:56.789Z",
        level: "info",
        tag: "startup",
        message: "boot",
      });

      assert.equal(consoleWrites, 0);
      assert.match(
        fs.readFileSync(logPath, "utf8"),
        /closedloop-gateway-log .*"tag":"startup"/
      );
    } finally {
      electronLog.transports.file.resolvePathFn = originalResolvePathFn;
      electronLog.transports.console.writeFn = originalConsoleWriteFn;
    }
  });
});
