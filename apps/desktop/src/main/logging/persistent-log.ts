import fs from "node:fs";
import path from "node:path";
import electron from "electron";
import electronLog from "electron-log/main.js";
import {
  BUILD_APP_VERSION,
  BUILD_COMMIT_HASH,
} from "../../shared/build-info.js";
import type { LogEntry, LogLevel } from "./gateway-logger.js";
import {
  formatDesktopBootLine,
  type MainLogLocationInput,
  resolveMainLogDirectory,
} from "./main-log-location.js";
import { PreInitLogBuffer } from "./pre-init-log-buffer.js";

const MAIN_LOG_FILE_NAME = "main.log";
const MAIN_LOG_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const PERSISTED_GATEWAY_ENTRY_PREFIX = "closedloop-gateway-log ";
const DEFAULT_PREVIOUS_SESSION_TAIL_LINES = 200;
const LOG_TAIL_READ_CHUNK_BYTES = 64 * 1024;
const LOG_TAIL_MAX_BYTES = 512 * 1024;
const ELECTRON_LOG_PREFIX_RE =
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[[^\]]+\]\s*/;
// Cap on lines held before {@link initializePersistentLogging} runs, so a launch
// path that exits before initializing can never grow this without bound.
const MAX_PREINIT_BUFFERED_LINES = 500;
const { app, shell } = electron;
disableElectronLogConsoleTransport();

type ElectronLogFile = {
  path: string;
  clear(): boolean;
};

let initialized = false;
// ISS-4916 (codex review): every write before the redirect is configured would
// otherwise land in the operator's production main.log even on a redirected
// launch. Held here and replayed by initializePersistentLogging.
const preInitLog = new PreInitLogBuffer<LogLevel | "debug">(
  MAX_PREINIT_BUFFERED_LINES
);

/**
 * Configures the durable Desktop main-process log file. The file transport is
 * the only electron-log transport enabled; GatewayLogger remains the only
 * allowlisted console/stdout transport.
 *
 * ISS-4916: when this instance runs on a redirected `userData` profile (an
 * Electron e2e temp dir, golden mode, an operator `--user-data-dir`), the log is
 * written INSIDE that profile instead of the shared production `main.log`.
 * Callers pass the resolved Electron paths so this module stays free of an
 * `electron` import and the decision stays unit-testable.
 *
 * Writes made before this runs are buffered (see {@link PreInitLogBuffer}) and
 * replayed here, so a redirected launch's earliest lines land in its own profile
 * rather than in the production log the transport defaults to.
 */
export function initializePersistentLogging(
  location?: MainLogLocationInput
): void {
  if (initialized) {
    return;
  }

  electronLog.initialize();
  disableElectronLogConsoleTransport();
  electronLog.transports.file.level = "debug";
  electronLog.transports.file.fileName = MAIN_LOG_FILE_NAME;
  const redirectedLogDir = location ? resolveMainLogDirectory(location) : null;
  if (redirectedLogDir) {
    electronLog.transports.file.resolvePathFn = () =>
      path.join(redirectedLogDir, MAIN_LOG_FILE_NAME);
  }
  electronLog.transports.file.maxSize = MAIN_LOG_MAX_SIZE_BYTES;
  electronLog.transports.file.archiveLogFn = (oldLogFile: ElectronLogFile) => {
    const parsed = path.parse(oldLogFile.path);
    const archivedPath = path.join(
      parsed.dir,
      `${parsed.name}.old${parsed.ext}`
    );
    try {
      fs.rmSync(archivedPath, { force: true });
      fs.renameSync(oldLogFile.path, archivedPath);
    } catch {
      oldLogFile.clear();
    }
  };

  initialized = true;
  // Drain AFTER the transport is configured: `drain()` closes the buffer, so the
  // replayed lines fall through to the real (now correctly located) file.
  for (const buffered of preInitLog.drain()) {
    writeElectronLog(buffered.level, buffered.line);
  }
}

/** Returns the absolute path to the durable Desktop main log. */
export function getMainLogFilePath(): string {
  return electronLog.transports.file.getFile().path;
}

/**
 * The `Desktop boot starting …` line for this instance (ISS-4916): baked build
 * identity plus the default/redirected profile marker and the resolved log path.
 * Thin electron-reading wrapper over {@link formatDesktopBootLine}, which owns
 * the format and is unit-tested without booting Electron.
 */
export function describeDesktopBootIdentity(): string {
  return formatDesktopBootLine({
    userDataPath: app.getPath("userData"),
    appDataPath: app.getPath("appData"),
    appName: app.getName(),
    buildAppVersion: BUILD_APP_VERSION,
    buildCommitHash: BUILD_COMMIT_HASH,
    electronVersion: process.versions.electron ?? "unknown",
    logFilePath: getMainLogFilePath(),
  });
}

/**
 * Opens the durable Desktop main log with the platform file handler.
 * Electron returns an empty string on success.
 */
export async function openMainLogFile(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const result = await shell.openPath(ensureMainLogFile());
  return result ? { ok: false, error: result } : { ok: true };
}

/** Writes a GatewayLogger entry to the durable file transport. */
export function writeGatewayLogEntry(entry: LogEntry): void {
  const line = `${PERSISTED_GATEWAY_ENTRY_PREFIX}${JSON.stringify(entry)}`;
  writeElectronLog(entry.level, line);
}

/** Writes a non-GatewayLogger line to the durable file transport. */
export function writePersistentLog(
  level: LogLevel | "debug",
  tag: string,
  message: string
): void {
  writeElectronLog(level, `[${tag}] ${message}`);
}

/**
 * Reads recent durable log lines as previous-session Diagnostics entries.
 * Missing or unreadable files return [] so Desktop boot is never blocked by log
 * tail recovery.
 */
export async function readPreviousSessionLogTail(
  limit = DEFAULT_PREVIOUS_SESSION_TAIL_LINES,
  filePath = getMainLogFilePath()
): Promise<LogEntry[]> {
  if (limit <= 0) {
    return [];
  }

  let content: string;
  try {
    content = await readLogTailContent(filePath, limit);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) {
      const message = error instanceof Error ? error.message : String(error);
      writePersistentLog(
        "warn",
        "persistent-log",
        `Unable to read previous log tail: ${message}`
      );
    }
    return [];
  }

  return parsePreviousSessionLogTail(content, limit);
}

/** Parses durable log content into previous-session Diagnostics entries. */
export function parsePreviousSessionLogTail(
  content: string,
  limit: number
): LogEntry[] {
  const rows = content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-Math.max(0, limit));

  return rows.map(parsePreviousSessionLogLine);
}

/** Parses one durable log line, tolerating non-GatewayLogger legacy lines. */
export function parsePreviousSessionLogLine(line: string): LogEntry {
  const gatewayEntryIndex = line.indexOf(PERSISTED_GATEWAY_ENTRY_PREFIX);
  if (gatewayEntryIndex >= 0) {
    const raw = line.slice(
      gatewayEntryIndex + PERSISTED_GATEWAY_ENTRY_PREFIX.length
    );
    try {
      const parsed = JSON.parse(raw) as Partial<LogEntry>;
      if (
        typeof parsed.timestamp === "string" &&
        isLogLevel(parsed.level) &&
        typeof parsed.tag === "string" &&
        typeof parsed.message === "string"
      ) {
        return {
          timestamp: parsed.timestamp,
          level: parsed.level,
          tag: parsed.tag,
          message: parsed.message,
          session: "previous",
        };
      }
    } catch {
      // Fall through to generic legacy parsing.
    }
  }

  return {
    timestamp: new Date().toISOString(),
    level: "info",
    tag: "desktop",
    message: line.replace(ELECTRON_LOG_PREFIX_RE, ""),
    session: "previous",
  };
}

function writeElectronLog(level: LogLevel | "debug", line: string): void {
  if (preInitLog.capture(level, line)) {
    return;
  }
  try {
    ensureMainLogDirectory();
    if (level === "error") {
      electronLog.error(line);
    } else if (level === "warn") {
      electronLog.warn(line);
    } else if (level === "debug") {
      electronLog.debug(line);
    } else {
      electronLog.info(line);
    }
  } catch {
    // Persistent logging must never affect Desktop control flow.
  }
}

function disableElectronLogConsoleTransport(): void {
  electronLog.transports.console.level = false;
  electronLog.transports.console.writeFn = () => undefined;
}

function ensureMainLogFile(): string {
  const filePath = getMainLogFilePath();
  ensureMainLogDirectory(filePath);
  fs.closeSync(fs.openSync(filePath, "a"));
  return filePath;
}

function ensureMainLogDirectory(filePath = getMainLogFilePath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function readLogTailContent(
  filePath: string,
  limit: number
): Promise<string> {
  const file = await fs.promises.open(filePath, "r");
  try {
    const stats = await file.stat();
    if (stats.size === 0) {
      return "";
    }

    const chunks: Buffer[] = [];
    let position = stats.size;
    let bytesReadTotal = 0;
    let lineBreakCount = 0;
    while (
      position > 0 &&
      bytesReadTotal < LOG_TAIL_MAX_BYTES &&
      lineBreakCount <= limit
    ) {
      const remainingBudget = LOG_TAIL_MAX_BYTES - bytesReadTotal;
      const readSize = Math.min(
        LOG_TAIL_READ_CHUNK_BYTES,
        position,
        remainingBudget
      );
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await file.read(buffer, 0, readSize, position);
      if (bytesRead === 0) {
        break;
      }

      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      bytesReadTotal += bytesRead;
      lineBreakCount += countLineBreaks(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await file.close();
  }
}

function countLineBreaks(chunk: Buffer): number {
  let count = 0;
  for (const byte of chunk) {
    if (byte === 10) {
      count++;
    }
  }
  return count;
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "info" || value === "warn" || value === "error";
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export { electronLog };
