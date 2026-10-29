/**
 * @file durable-log-sink.ts
 * @description ISS-7882 — the shape of a sink that carries a durable main-log
 * line off the process that wrote it, the level predicate the db-host message
 * boundary validates against, and (ISS-8906) the durable write path itself.
 *
 * Kept free of `electron` and `electron-log` so every end can depend on it:
 * `persistent-log.ts` (which owns the electron-log file transport and installs
 * it here), `db-host-protocol.ts` (which validates a relayed line arriving from
 * the child), and the db-host utilityProcess and db-store worker thread, which
 * must stay loadable where there is no `app` — and, in a worker thread, no
 * `electron` built-in at all.
 */

import type { LogEntry, LogLevel } from "./gateway-logger.js";
import { PreInitLogBuffer } from "./pre-init-log-buffer.js";

/**
 * The levels the durable file transport accepts. Wider than {@link LogLevel} by
 * exactly `debug`, which electron-log's file transport records but the
 * GatewayLogger entry shape does not carry.
 */
export type DurableLogLevel = LogLevel | "debug";

/**
 * Hands one ALREADY-FORMATTED durable line to whatever carries it off this
 * process. `line` is what the file transport would have written verbatim — the
 * `[tag] message` form for {@link writePersistentLog}, the
 * `closedloop-gateway-log {…}` form for a GatewayLogger entry — so a relayed
 * line is byte-identical to a locally written one and the sink needs no
 * knowledge of either format.
 *
 * Must not throw: durable logging is called from arbitrary code paths that
 * treat it as fire-and-forget, so a transport failure is the sink's problem to
 * absorb, never the caller's.
 */
export type DurableLogSink = (level: DurableLogLevel, line: string) => void;

/**
 * Membership is a typed `Record` over the union rather than an `||` chain, so
 * widening {@link DurableLogLevel} fails `tsc` here instead of silently leaving
 * the new member unrecognised at the process boundary.
 */
const DURABLE_LOG_LEVELS: Record<DurableLogLevel, true> = {
  info: true,
  warn: true,
  error: true,
  debug: true,
};

export function isDurableLogLevel(value: unknown): value is DurableLogLevel {
  return typeof value === "string" && Object.hasOwn(DURABLE_LOG_LEVELS, value);
}

/**
 * ISS-8906 — the durable WRITE PATH lives here too, not just the sink type.
 *
 * `persistent-log.ts` still owns the electron-log file transport, and still
 * owns it alone; what moved is the part that has no business importing
 * `electron`: the pre-init buffer, the installed relay sink, and the three
 * `write*` entry points. The DB store thread reaches
 * `routeDurableLogsToSink` (from `db-store-host.ts`) and `writePersistentLog`
 * (from the hydration, token-count and backfill paths), and since ISS-8246 M1
 * that thread is a `node:worker_threads` worker with NO `electron` built-in —
 * so loading `persistent-log.ts` there threw `Cannot find module 'electron'`,
 * the store never opened, and every install that took 0.16.1713 captured
 * nothing. `apps/desktop/test/worker-entry-electron-free-graph.test.ts` is the
 * guard; keep this module free of `electron` and `electron-log`.
 *
 * Every caller of the three `write*` entry points imports them from HERE;
 * `persistent-log.ts` keeps only the electron-log file transport, which it
 * installs through {@link installLocalDurableTransport}.
 */

/** Cap on lines held before a durable transport or sink exists. */
export const MAX_PREINIT_BUFFERED_LINES = 500;
export const PERSISTED_GATEWAY_ENTRY_PREFIX = "closedloop-gateway-log ";
// Bounds of the C0 control block and DEL - see toSingleLogLine.
const FIRST_PRINTABLE_CODEPOINT = 0x20;
const DELETE_CODEPOINT = 0x7f;

// ISS-7882: installed by a process that owns no file transport (the db-host
// utilityProcess, the db-store worker thread) so its durable lines reach main's.
// Null in main, where the write path below is byte-for-byte what it was.
let durableLogSink: DurableLogSink | null = null;
// The process-local durable writer, installed by `persistent-log.ts` in a
// process that HAS electron-log. Null in the db-host utilityProcess and the
// db-store worker thread, which route to a relay sink instead.
let localDurableTransport: DurableLogSink | null = null;
// The buffer is handed over ONCE, to whichever durable sink arrives first (main's
// file transport, or a child's relay), so the overflow below is reported once
// rather than re-announced by every later installer.
let preInitDrained = false;
// ISS-4916 (codex review): every write before the redirect is configured would
// otherwise land in the operator's production main.log even on a redirected
// launch. Held here and replayed by initializePersistentLogging.
const preInitLog = new PreInitLogBuffer<DurableLogLevel>(
  MAX_PREINIT_BUFFERED_LINES
);

/**
 * Install the process-local durable writer. `persistent-log.ts` is the only
 * caller; it deliberately does NOT drain, because the drain is what
 * `initializePersistentLogging` performs once the transport points at the right
 * profile (ISS-4916).
 */
export function installLocalDurableTransport(transport: DurableLogSink): void {
  localDurableTransport = transport;
}

/** Replay the pre-init buffer into the process-local transport. */
export function drainPreInitLogToLocalTransport(): void {
  if (localDurableTransport) {
    drainPreInitLogInto(localDurableTransport);
  }
}

/** Writes a GatewayLogger entry to the durable file transport. */
export function writeGatewayLogEntry(entry: LogEntry): void {
  const line = `${PERSISTED_GATEWAY_ENTRY_PREFIX}${JSON.stringify(entry)}`;
  writeDurableLine(entry.level, line);
}

/** Writes a non-GatewayLogger line to the durable file transport. */
export function writePersistentLog(
  level: DurableLogLevel,
  tag: string,
  message: string
): void {
  writeDurableLine(level, `[${tag}] ${message}`);
}

function writeDurableLine(level: DurableLogLevel, line: string): void {
  if (preInitLog.capture(level, line)) {
    return;
  }
  // ISS-7882: a process with a relay has no usable file transport of its own, so
  // the relay REPLACES the local write rather than teeing it. Checked after the
  // buffer so a line written before the relay was installed is still replayed
  // through it by `routeDurableLogsToSink`.
  if (durableLogSink) {
    durableLogSink(level, line);
    return;
  }
  localDurableTransport?.(level, line);
}

/**
 * ISS-7882 — route this process's durable lines to `sink` instead of to a local
 * electron-log file transport, and replay everything already buffered.
 *
 * Call once, at process start. The db-host `utilityProcess` and the db-store
 * worker thread are the callers, and initialising a file transport in there
 * instead is not the milder option: with no `app` to resolve a directory from,
 * electron-log falls back to a GUESSED path rather than the operator's profile
 * and never to the ISS-4916 redirect, and a second transport aimed at main's
 * `main.log` would give one file two independent rotation controllers, each
 * renaming it out from under the other. Relaying keeps one writer.
 */
export function routeDurableLogsToSink(sink: DurableLogSink | null): void {
  durableLogSink = sink;
  if (sink) {
    drainPreInitLogInto(sink);
  }
}

/**
 * ISS-7882 — write a line another process relayed here.
 *
 * The counterpart of {@link routeDurableLogsToSink}: `line` was already
 * formatted by the writing process (a `[tag] message`, or a
 * `closedloop-gateway-log {…}` entry), so it is appended rather than re-wrapped,
 * and a relayed `warn` stays a `warn`.
 *
 * Two things are enforced HERE rather than at the message boundary, because both
 * of the alternatives there are worse than the fault they would catch:
 *
 * `level` is whatever crossed the boundary, so an unusable one is degraded to
 * `warn` and SAID, never used to discard the line — dropping a durable line for
 * a bad severity is the defect this relay exists to end.
 *
 * Control characters are neutralised so ONE relayed message is ONE log line. A
 * relayed line quotes runtime data (session ids, error text), and a newline in
 * it would otherwise append a second line the reader cannot tell from a genuine
 * entry — the same forgery `parsePreviousSessionLogLine` would then parse back
 * as a previous session's record.
 */
export function writeRelayedDurableLog(level: unknown, line: string): void {
  const known = isDurableLogLevel(level);
  const prefix = known
    ? ""
    : `[persistent-log] relayed line carried an unusable level (${describeUnusableLevel(level)}); recorded at warn — `;
  writeDurableLine(known ? level : "warn", toSingleLogLine(prefix + line));
}

/** A bounded, quotable rendering of a level that is not a level. */
function describeUnusableLevel(level: unknown): string {
  return typeof level === "string"
    ? JSON.stringify(level.slice(0, 32))
    : typeof level;
}

/**
 * Collapse every C0 control character and DEL to a space, so the result occupies
 * exactly one line. A space rather than removal: the characters were separators
 * in the writer's intent, and eliding them would silently join two words.
 *
 * A codepoint scan rather than a regex, so the control characters this must
 * match do not have to appear in a regex literal (`noControlCharactersInRegex`).
 */
function toSingleLogLine(line: string): string {
  let collapsed = "";
  for (const character of line) {
    const code = character.codePointAt(0) ?? 0;
    collapsed +=
      code < FIRST_PRINTABLE_CODEPOINT || code === DELETE_CODEPOINT
        ? " "
        : character;
  }
  return collapsed;
}

/**
 * Hand everything held before a durable sink existed to the sink that now
 * exists, then STATE the overflow.
 *
 * The cap discards the (cap + 1)-th line and every line after it
 * ({@link PreInitLogBuffer.capture} keeps the EARLIEST, which are the boot
 * record this buffer exists to preserve). Discarding them is the right trade;
 * discarding them in silence is a smaller copy of the defect ISS-7882 closed, so
 * the count is reported on the sink that just became available.
 */
function drainPreInitLogInto(sink: DurableLogSink): void {
  if (preInitDrained) {
    return;
  }
  preInitDrained = true;
  const buffered = preInitLog.drain();
  for (const entry of buffered) {
    sink(entry.level, entry.line);
  }
  const dropped = preInitLog.dropped;
  if (dropped > 0) {
    sink(
      "warn",
      `[persistent-log] ${dropped} durable line(s) exceeded the ${MAX_PREINIT_BUFFERED_LINES}-line pre-init buffer and were dropped; the ${buffered.length} earliest were kept`
    );
  }
}
