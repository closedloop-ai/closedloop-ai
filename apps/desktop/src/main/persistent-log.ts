import fs from "node:fs";
import path from "node:path";
import electron from "electron";
import electronLog from "electron-log/main.js";
import type { LogEntry, LogLevel } from "./gateway-logger.js";

const MAIN_LOG_FILE_NAME = "main.log";
const MAIN_LOG_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const PERSISTED_GATEWAY_ENTRY_PREFIX = "closedloop-gateway-log ";
const DEFAULT_PREVIOUS_SESSION_TAIL_LINES = 200;
const LOG_TAIL_READ_CHUNK_BYTES = 64 * 1024;
const LOG_TAIL_MAX_BYTES = 512 * 1024;
const ELECTRON_LOG_PREFIX_RE =
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[[^\]]+\]\s*/;
const { shell } = electron;
disableElectronLogConsoleTransport();

type ElectronLogFile = {
  path: string;
  clear(): boolean;
};

let initialized = false;

/**
 * Configures the durable Desktop main-process log file. The file transport is
 * the only electron-log transport enabled; GatewayLogger remains the only
 * allowlisted console/stdout transport.
 */
export function initializePersistentLogging(): void {
  if (initialized) {
    return;
  }

  electronLog.initialize();
  disableElectronLogConsoleTransport();
  electronLog.transports.file.level = "debug";
  electronLog.transports.file.fileName = MAIN_LOG_FILE_NAME;
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
}

/** Returns the absolute path to the durable Desktop main log. */
export function getMainLogFilePath(): string {
  return electronLog.transports.file.getFile().path;
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
