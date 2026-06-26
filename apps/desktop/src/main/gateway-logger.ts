/**
 * Structured logger for the desktop gateway.
 * All log entries are timestamped, tagged by subsystem, and optionally
 * buffered in-memory so the UI can display recent entries.
 */

import { writeGatewayLogEntry } from "./persistent-log.js";

export type LogLevel = "info" | "warn" | "error";
export type LogSession = "current" | "previous";
export type LogMessageFactory = string | (() => string);

export type LogEntry = {
  timestamp: string;
  level: LogLevel;
  tag: string;
  message: string;
  session?: LogSession;
};

const MAX_BUFFER_SIZE = 500;

export class GatewayLogger {
  private verbose = false;
  private readonly buffer: LogEntry[] = [];
  private onChange?: (entries: LogEntry[]) => void;
  private lastMessage = "";

  constructor(private readonly persistentSink = writeGatewayLogEntry) {}

  setVerbose(enabled: boolean): void {
    if (this.verbose === enabled) {
      return;
    }
    this.verbose = enabled;
    this.info(
      "logger",
      enabled ? "Verbose logging enabled" : "Verbose logging disabled"
    );
  }

  isVerbose(): boolean {
    return this.verbose;
  }

  setOnChange(cb: (entries: LogEntry[]) => void): void {
    this.onChange = cb;
  }

  info(tag: string, message: string): void {
    this.log("info", tag, message);
  }

  warn(tag: string, message: string): void {
    this.log("warn", tag, message);
  }

  error(tag: string, message: string): void {
    this.log("error", tag, message);
  }

  /** Verbose-only log -- skipped without invoking lazy formatting when off. */
  debug(tag: string, message: LogMessageFactory): void {
    if (!this.verbose) {
      return;
    }
    this.log("info", tag, typeof message === "function" ? message() : message);
  }

  getEntries(): LogEntry[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer.length = 0;
    this.lastMessage = "";
    this.onChange?.([]);
  }

  seedPreviousSessionEntries(entries: LogEntry[]): void {
    if (entries.length === 0) {
      return;
    }

    const previousEntries = entries.map((entry) => ({
      ...entry,
      session: "previous" as const,
    }));
    this.buffer.push(...previousEntries);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER_SIZE);
    }
    this.onChange?.([...this.buffer]);
  }

  private log(level: LogLevel, tag: string, message: string): void {
    const key = `${level}:${tag}:${message}`;
    if (key === this.lastMessage) {
      return;
    }
    this.lastMessage = key;

    const now = new Date();
    const ts = now.toISOString();
    const entry: LogEntry = {
      timestamp: ts,
      level,
      tag,
      message,
      session: "current",
    };

    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER_SIZE);
    }

    const short = now.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    });
    const prefix = `[${tag}][${short}]`;
    if (level === "error") {
      console.error(prefix, message);
    } else if (level === "warn") {
      console.warn(prefix, message);
    } else {
      console.log(prefix, message);
    }

    this.persistentSink(entry);
    this.onChange?.([...this.buffer]);
  }
}

/** Singleton instance shared across the app. */
export const gatewayLog = new GatewayLogger();

const NETWORK_ERROR_RE =
  /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i;

/** Returns true when the message looks like a transient network failure. */
export function isNetworkError(message: string): boolean {
  return NETWORK_ERROR_RE.test(message);
}
