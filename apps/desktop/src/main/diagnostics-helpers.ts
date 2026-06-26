/**
 * Shared diagnostics helpers for loop finalization and failure handling.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  STDERR_TAIL_MAX_BYTES,
  STDERR_TAIL_MAX_LINES,
  TELEMETRY_LOG_TAIL_LINES,
  TELEMETRY_LOG_TAIL_MAX_BYTES,
} from "./telemetry-protocol.js";

/** Remove ANSI escape sequences from a string. */
const ANSI_PATTERN =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Read up to `maxBytes` from the tail of a file, returning at most `maxLines` lines.
 * Returns null when missing/empty/unreadable.
 */
export function readFileTail(
  filePath: string,
  maxBytes: number,
  maxLines: number
): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const stat = statSync(filePath);
    const fileSize = stat.size;
    if (fileSize === 0) {
      return null;
    }

    const readBytes = Math.min(fileSize, maxBytes);
    const offset = fileSize - readBytes;
    const buf = Buffer.alloc(readBytes);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buf, 0, readBytes, offset);
    } finally {
      closeSync(fd);
    }

    const raw = buf.toString("utf-8");
    const tail =
      offset > 0
        ? (() => {
            const newlineIdx = raw.indexOf("\n");
            return newlineIdx === -1 ? raw : raw.slice(newlineIdx + 1);
          })()
        : raw;

    const lines = tail.split("\n");
    if (lines.length > maxLines) {
      return lines.slice(-maxLines).join("\n");
    }
    return tail;
  } catch {
    return null;
  }
}

/** Read a text file; returns null if missing or unreadable. */
export function readTextFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read up to TELEMETRY_LOG_TAIL_MAX_BYTES from the tail of a log file.
 * Returns null when missing/empty/unreadable.
 */
export function readLogTail(logPath: string): string | null {
  return readFileTail(
    logPath,
    TELEMETRY_LOG_TAIL_MAX_BYTES,
    TELEMETRY_LOG_TAIL_LINES
  );
}

/**
 * Read up to STDERR_TAIL_MAX_BYTES from the tail of claude-stderr.log.
 * Returns null when missing/empty/unreadable.
 */
export function readStderrTail(claudeWorkDir: string): string | null {
  const stderrPath = path.join(claudeWorkDir, "claude-stderr.log");
  return readFileTail(stderrPath, STDERR_TAIL_MAX_BYTES, STDERR_TAIL_MAX_LINES);
}

/** Redact obvious secrets and cap message length for safe logging/storage. */
export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/:\/\/[^@]+@/g, "://***@")
    .replace(/\b[0-9a-f]{20,}\b/gi, "[REDACTED]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[REDACTED]")
    .slice(0, 500);
}
