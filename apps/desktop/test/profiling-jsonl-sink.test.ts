import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createJsonlSink } from "../src/main/profiling/jsonl-sink.js";
import {
  PROFILING_DROPPED_ROWS_KEY,
  type ProfilingIpcRow,
} from "../src/shared/profiling.js";

let workDir = "";

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "profiling-jsonl-"));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readRows(filePath: string): Record<string, unknown>[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function ipcRow(index: number): ProfilingIpcRow {
  return { channel: `desktop:op-${index}`, ms: index, ts: 1000 + index };
}

function isLossMarker(row: Record<string, unknown>): boolean {
  return PROFILING_DROPPED_ROWS_KEY in row;
}

function lossMarkers(rows: Record<string, unknown>[]) {
  return rows.filter(isLossMarker);
}

/** Parse the JSONL a stubbed writer accepted, in write order. */
function parseWritten(written: string[]): Record<string, unknown>[] {
  return written
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** A writer that rejects its first batch, then accepts everything after. */
function createWriterFailingOnce(error: string) {
  const written: string[] = [];
  let failNext = true;
  return {
    written,
    appendFn: (_target: string, chunk: string) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error(error));
      }
      written.push(chunk);
      return Promise.resolve();
    },
  };
}

describe("jsonl sink", () => {
  test("the loss-marker key is the literal the analyzer reads", () => {
    // Cross-module contract: `scripts/perf/` recognizes this exact key to
    // surface a lossy capture in report.md. Every other assertion in this file
    // reads the constant, so only pinning the literal here catches a rename
    // that would leave the analyzer silently blind to dropped rows.
    assert.equal(PROFILING_DROPPED_ROWS_KEY, "perfSinkDroppedRows");
  });

  test("flushes buffered rows on close", async () => {
    const filePath = path.join(workDir, "small.jsonl");
    const sink = createJsonlSink(filePath);

    sink.append(ipcRow(1));
    sink.append(ipcRow(2));
    sink.append(ipcRow(3));
    await sink.close();

    assert.deepEqual(readRows(filePath), [ipcRow(1), ipcRow(2), ipcRow(3)]);
  });

  test("bounds the buffer and accounts for every shed row", async () => {
    const filePath = path.join(workDir, "bounded.jsonl");
    const sink = createJsonlSink(filePath);

    // Appended synchronously, so no write can complete mid-loop: the buffer
    // genuinely grows past the ceiling and the drop-oldest path runs. 12_000
    // clears the 10_000 ceiling with room for the post-shed refill.
    const appended = 12_000;
    for (let index = 0; index < appended; index += 1) {
      sink.append(ipcRow(index));
    }
    await sink.close();

    const rows = readRows(filePath);
    const markers = lossMarkers(rows);
    assert.equal(markers.length, 1, "expected exactly one loss marker");
    const dropped = Number(markers[0]?.[PROFILING_DROPPED_ROWS_KEY]);
    assert.ok(dropped > 0, "expected rows to be shed at the cap");

    const dataRows = rows.filter((row) => !isLossMarker(row));
    assert.equal(
      dataRows.length + dropped,
      appended,
      "every appended row is either written or counted as dropped"
    );
    // Drop-OLDEST: the newest rows are the ones that survive.
    assert.equal(dataRows.at(-1)?.channel, `desktop:op-${appended - 1}`);
  });

  test("rows lost with a failed write batch are counted, not silently dropped", async () => {
    const filePath = path.join(workDir, "failed-batch.jsonl");
    const writer = createWriterFailingOnce("ENOSPC");
    const sink = createJsonlSink(filePath, { appendFn: writer.appendFn });

    // First batch: three rows, rejected by the disk. Without the accounting
    // these vanish and the analyzer computes percentiles over a population it
    // has no idea is short three rows.
    sink.append(ipcRow(1));
    sink.append(ipcRow(2));
    sink.append(ipcRow(3));
    sink.flush();
    await sink.close();

    const markers = lossMarkers(parseWritten(writer.written));
    assert.equal(markers.length, 1, "expected exactly one loss marker");
    assert.equal(
      markers[0]?.[PROFILING_DROPPED_ROWS_KEY],
      3,
      "the marker reports the failed batch's ROW COUNT, not one failure"
    );
    assert.equal(typeof markers[0]?.ts, "number", "marker carries an epoch ts");
  });

  test("loss during the close drain still reaches the marker", async () => {
    const filePath = path.join(workDir, "loss-during-drain.jsonl");
    const writer = createWriterFailingOnce("EIO");
    const sink = createJsonlSink(filePath, { appendFn: writer.appendFn });

    // Nothing has been flushed yet, so the failing batch is the one close()
    // itself starts. The marker is composed AFTER that drain, which is the only
    // reason this loss is visible at all.
    sink.append(ipcRow(1));
    sink.append(ipcRow(2));
    await sink.close();

    const markers = lossMarkers(parseWritten(writer.written));
    assert.equal(markers.length, 1);
    assert.equal(markers[0]?.[PROFILING_DROPPED_ROWS_KEY], 2);
  });

  test("no marker is written when nothing was dropped", async () => {
    const filePath = path.join(workDir, "lossless.jsonl");
    const sink = createJsonlSink(filePath);

    sink.append(ipcRow(1));
    sink.append(ipcRow(2));
    await sink.close();

    const rows = readRows(filePath);
    assert.deepEqual(
      rows.filter(isLossMarker),
      [],
      "a clean capture must not carry a loss marker"
    );
    assert.deepEqual(rows, [ipcRow(1), ipcRow(2)]);
  });

  test("a synchronously throwing writer is counted and never escapes", async () => {
    const filePath = path.join(workDir, "sync-throw.jsonl");
    const sink = createJsonlSink(filePath, {
      appendFn: () => {
        throw new Error("writer exploded synchronously");
      },
    });

    assert.doesNotThrow(() => {
      sink.append(ipcRow(1));
      sink.append(ipcRow(2));
      sink.flush();
    });
    await sink.close();

    assert.equal(
      existsSync(filePath),
      false,
      "nothing could be written, so no file — and no throw reached the caller"
    );
  });

  test("an unwritable path never surfaces an error to the caller", async () => {
    // The directory does not exist, so every append/flush/close write fails.
    const filePath = path.join(workDir, "missing-dir", "out.jsonl");
    const sink = createJsonlSink(filePath);

    assert.doesNotThrow(() => {
      sink.append(ipcRow(1));
      sink.flush();
      sink.append(ipcRow(2));
    });
    await sink.close();

    assert.equal(existsSync(filePath), false);
  });

  test("an unserializable row is dropped rather than thrown", async () => {
    const filePath = path.join(workDir, "unserializable.jsonl");
    const sink = createJsonlSink(filePath);
    const circular: Record<string, unknown> = { channel: "desktop:cycle" };
    circular.self = circular;

    assert.doesNotThrow(() => {
      // The public row union cannot express a cycle; the guard exists for what
      // actually reaches the sink at runtime, so drive it through the same
      // append the call sites use.
      (sink.append as (row: unknown) => void)(circular);
      sink.append(ipcRow(9));
    });
    await sink.close();

    assert.deepEqual(readRows(filePath), [ipcRow(9)]);
  });

  test("appends after close are ignored", async () => {
    const filePath = path.join(workDir, "after-close.jsonl");
    const sink = createJsonlSink(filePath);

    sink.append(ipcRow(1));
    await sink.close();
    sink.append(ipcRow(2));
    await sink.close();

    assert.deepEqual(readRows(filePath), [ipcRow(1)]);
  });

  test("the interval flush lands rows without a close", async () => {
    const filePath = path.join(workDir, "interval.jsonl");
    let scheduled: (() => void) | null = null;
    const sink = createJsonlSink(filePath, {
      // Drive the cadence explicitly instead of waiting on a real 2s timer.
      setIntervalFn: ((handler: () => void) => {
        scheduled = handler;
        return { unref() {} } as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => {
        scheduled = null;
      }) as unknown as typeof clearInterval,
    });

    sink.append(ipcRow(1));
    assert.ok(scheduled, "expected a flush interval to be scheduled");
    (scheduled as unknown as () => void)();
    // The flush is fire-and-forget; close() awaits the write it started.
    await sink.close();

    assert.deepEqual(readRows(filePath), [ipcRow(1)]);
  });
});
