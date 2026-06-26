import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { LoopEventType } from "@closedloop-ai/loops-api/events";
import { gatewayLog } from "../../main/gateway-logger.js";
import { withTokenRefreshRetry } from "../../main/loop-refresh.js";
import type { LoopTokenStore } from "../../main/loop-token-store.js";
import { resolveClaudeOutputPath } from "../../main/token-usage.js";
import { isRecord } from "../../shared/type-guards.js";
import { type LoopHttpResult, postLoopEvent } from "./loop-http.js";

// ---------------------------------------------------------------------------
// JSONL record types (Claude CLI streaming output)
// ---------------------------------------------------------------------------

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = {
  type: "tool_use";
  name: string;
  input?: Record<string, unknown>;
};
type ThinkingBlock = { type: "thinking" };
type ToolResultBlock = {
  type: "tool_result";
  is_error?: boolean;
  content?: string | unknown[];
};

type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | ToolResultBlock;

type AssistantRecord = {
  type: "assistant";
  message: { content: ContentBlock[] };
};

type UserRecord = {
  type: "user";
  message: { content: ContentBlock[] };
};

type ContentBlockDeltaRecord = {
  type: "content_block_delta";
  delta: { type: "text_delta"; text: string };
};

type ResultRecord = {
  type: "result";
  subtype?: "success" | "error";
  is_error?: boolean;
  result?: string;
  error?: string;
};

export type JsonlRecord =
  | AssistantRecord
  | UserRecord
  | ContentBlockDeltaRecord
  | ResultRecord;

type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

function emptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function addTokenTotals(left: TokenTotals, right: TokenTotals): TokenTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheCreationInputTokens:
      left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    cacheReadInputTokens:
      left.cacheReadInputTokens + right.cacheReadInputTokens,
  };
}

function hasAnyTokenTotals(tokens: TokenTotals): boolean {
  return (
    tokens.inputTokens > 0 ||
    tokens.outputTokens > 0 ||
    tokens.cacheCreationInputTokens > 0 ||
    tokens.cacheReadInputTokens > 0
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function redactSensitive(input: string): string {
  return input
    .replace(/AKIA[A-Z0-9]{16}/g, "[REDACTED]")
    .replace(/sk-ant-[A-Za-z0-9\-_]+/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9]{32,}/g, "[REDACTED]")
    .replace(/Bearer [A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
    .replace(/-----BEGIN [A-Z ]+ KEY-----/g, "[REDACTED]");
}

function summarizeToolInput(
  name: string,
  input: Record<string, unknown>
): string {
  const filePath = input.file_path ?? input.path;
  if (typeof filePath === "string") {
    return `Tool: ${name}(${truncate(filePath, 80)})`;
  }
  if (typeof input.command === "string") {
    return `Tool: ${name}(${truncate(input.command, 80)})`;
  }
  if (typeof input.pattern === "string") {
    return `Tool: ${name}(${truncate(input.pattern, 80)})`;
  }
  return `Tool: ${name}`;
}

function summarizeToolResult(block: ToolResultBlock): string {
  if (block.is_error === true) {
    return "Tool error";
  }
  const content = block.content;
  if (typeof content === "string" && content.length > 0) {
    return `Tool result: ${truncate(content, 120)}`;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        return `Tool result: ${truncate(part.text, 120)}`;
      }
    }
  }
  return "Tool result";
}

/** Accepts a parsed JSONL record (untrusted) and returns a display summary, or null to skip. */
export function summarizeJsonlRecord(
  record: Record<string, unknown>
): string | null {
  const typed = record as JsonlRecord;

  switch (typed.type) {
    case "assistant":
    case "user": {
      const message = isRecord(typed.message) ? typed.message : null;
      if (!message) {
        return null;
      }
      const content = Array.isArray(message.content)
        ? (message.content as ContentBlock[])
        : [];
      for (const block of content) {
        if (!isRecord(block)) {
          continue;
        }
        switch (block.type) {
          case "tool_use": {
            const b = block as ToolUseBlock;
            const input = isRecord(b.input) ? b.input : {};
            return redactSensitive(
              summarizeToolInput(String(b.name ?? "unknown"), input)
            );
          }
          case "text":
            return redactSensitive(
              truncate(String((block as TextBlock).text ?? ""), 200)
            );
          case "thinking":
            return redactSensitive("Thinking...");
          case "tool_result":
            return redactSensitive(
              summarizeToolResult(block as ToolResultBlock)
            );
        }
      }
      return null;
    }
    case "content_block_delta": {
      const delta = isRecord(typed.delta) ? typed.delta : null;
      if (
        delta &&
        (delta as ContentBlockDeltaRecord["delta"]).type === "text_delta"
      ) {
        return redactSensitive(
          truncate(
            String((delta as ContentBlockDeltaRecord["delta"]).text ?? ""),
            200
          )
        );
      }
      return null;
    }
    case "result": {
      const r = typed as ResultRecord;
      if (r.subtype === "success") {
        return redactSensitive("Turn complete");
      }
      if (r.subtype === "error" || r.is_error === true) {
        return redactSensitive(
          `Error: ${truncate(String(r.result ?? r.error ?? ""), 200)}`
        );
      }
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Output tailer
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 2000;
const DEFAULT_THROTTLE_MS = 5000;
const DEFAULT_AUTH_RETRY_BASE_MS = 1000;
const DEFAULT_AUTH_RETRY_MAX_MS = 30_000;
const DEFAULT_AUTH_RETRY_MAX_COUNT = 8;

type PollOptions = {
  ignoreBackoff?: boolean;
  forceAttempt?: boolean;
};

/**
 * Per-line observability sink invoked for every parsed JSONL record (native
 * loops only). Returns an optional token delta to fold into the tailer's
 * Output-event token accounting (Codex `turn.completed.usage`); returns
 * undefined for records that carry no token usage. The sink itself owns the
 * canonical `loop.perf.*` emit + active-agents routing; the tailer only forwards
 * the parsed record and consumes the returned token delta.
 */
export type ObservabilityRecordSink = (record: Record<string, unknown>) =>
  | {
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
    }
  | undefined;

/**
 * Tail Claude JSONL output and POST summarized `output` events.
 *
 * `onOffset` receives only **replay-safe** byte offsets: after a full newline-delimited
 * frame is consumed, and — when an `output` POST is required — only after the server
 * accepts it (2xx). Partial tail bytes and rejected auth (401/403) never advance the
 * reported offset. Transient POST failures keep the frame buffered for retry.
 */
export function startOutputTailer(
  jsonlPath: string,
  apiBaseUrl: string,
  loopId: string,
  getToken: () => string | null,
  initialByteOffset: number,
  onOffset?: (offset: number) => void,
  claudeWorkDir?: string,
  loopTokenStore?: LoopTokenStore,
  onJsonlRecord?: ObservabilityRecordSink
): { stop: () => void; flush: () => Promise<void> } {
  const parseEnvNumber = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") {
      return fallback;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  // pollIntervalMs falls back when 0 because a 0ms setInterval would spin the loop.
  const pollIntervalMs =
    Number(process.env.CLOSEDLOOP_TAILER_POLL_MS) || DEFAULT_POLL_MS;
  const throttleMs = parseEnvNumber(
    "CLOSEDLOOP_TAILER_THROTTLE_MS",
    DEFAULT_THROTTLE_MS
  );
  const authRetryBaseMs = parseEnvNumber(
    "CLOSEDLOOP_TAILER_AUTH_RETRY_BASE_MS",
    DEFAULT_AUTH_RETRY_BASE_MS
  );
  const authRetryMaxMs = parseEnvNumber(
    "CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_MS",
    DEFAULT_AUTH_RETRY_MAX_MS
  );
  const authRetryMaxCount = parseEnvNumber(
    "CLOSEDLOOP_TAILER_AUTH_RETRY_MAX_COUNT",
    DEFAULT_AUTH_RETRY_MAX_COUNT
  );
  let stopped = false;
  let authRetriesExhausted = false;
  let authRetryAttempt = 0;
  let nextAuthRetryAt = 0;
  /** Next byte to read from the JSONL file (may point past uncommitted tail in `pendingRemainder`). */
  let readByteOffset = initialByteOffset;
  /** Bytes read from disk not yet removed from `pendingRemainder` (no successful commit for that prefix). */
  let pendingRemainder = Buffer.alloc(0);
  let lastSentAt: number | null = null;
  /** Largest replay-safe offset reported via `onOffset` (exclusive end of committed prefix). */
  let committedByteOffset = initialByteOffset;
  /** Running token totals, committed only after a successful POST. */
  let tokenTotals = emptyTokenTotals();
  let observedFrame: {
    endExclusive: number;
    nativeFrameDelta: TokenTotals;
  } | null = null;
  /** Single-flight guard: prevents overlapping pollOnce executions. */
  let inFlightPoll: Promise<void> | null = null;

  function readFileIdentity(candidatePath: string): string | null {
    try {
      const stats = statSync(candidatePath);
      if (!stats.isFile()) {
        return null;
      }
      return `${stats.dev}:${stats.ino}`;
    } catch {
      return null;
    }
  }

  function resolveReadableJsonlPath(): string | null {
    if (existsSync(jsonlPath)) {
      return jsonlPath;
    }
    if (claudeWorkDir) {
      return resolveClaudeOutputPath(claudeWorkDir);
    }
    return null;
  }

  const initialReadableJsonlPath = resolveReadableJsonlPath();
  let activeJsonlPath = initialReadableJsonlPath ?? jsonlPath;
  let activeFileIdentity =
    initialReadableJsonlPath === null
      ? null
      : readFileIdentity(initialReadableJsonlPath);

  function updateActiveJsonlPath(candidatePath: string): boolean {
    const identity = readFileIdentity(candidatePath);
    if (identity === null) {
      return false;
    }
    if (identity !== activeFileIdentity) {
      readByteOffset = 0;
      pendingRemainder = Buffer.alloc(0);
      committedByteOffset = 0;
      tokenTotals = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      lastSentAt = null;
    }
    activeJsonlPath = candidatePath;
    activeFileIdentity = identity;
    return true;
  }

  function reportCommit(framedEndExclusive: number): void {
    if (framedEndExclusive > committedByteOffset) {
      committedByteOffset = framedEndExclusive;
      onOffset?.(committedByteOffset);
    }
  }

  function resetAuthRetryState(): void {
    authRetryAttempt = 0;
    nextAuthRetryAt = 0;
  }

  // Retry policy keyed on the structured `kind` discriminator from
  // postLoopEvent so the decision doesn't depend on substring matching of
  // human-readable error strings (the old `error.includes("401")` approach
  // silently broke whenever the error-string format drifted).
  function shouldRetryOnResult(result: LoopHttpResult): boolean {
    if (result.success) {
      return false;
    }
    switch (result.kind) {
      case "http":
        // Auth failures (401/403) and server errors (5xx) are retried; other
        // 4xx are terminal (request shape is wrong, retrying won't help).
        return (
          result.status === 401 || result.status === 403 || result.status >= 500
        );
      case "network":
      case "timeout":
        return true;
      case "auth":
        // Missing token usually means the gateway hasn't been re-authed yet;
        // retry with the same backoff as 401 so the tailer waits for the
        // token to appear rather than spinning or giving up immediately.
        return true;
    }
  }

  function formatResultForLog(result: LoopHttpResult): string {
    if (result.success) {
      return `success status=${result.status}`;
    }
    if (result.kind === "http") {
      return `kind=${result.kind} status=${result.status} error=${result.error}`;
    }
    return `kind=${result.kind} error=${result.error}`;
  }

  function scheduleAuthRetry(result: LoopHttpResult): void {
    authRetryAttempt += 1;
    if (authRetryAttempt > authRetryMaxCount) {
      authRetriesExhausted = true;
      gatewayLog.warn(
        "output-tailer",
        `Stopping tailer for loopId=${loopId}: exhausted auth retries after ${authRetryMaxCount} attempts (last ${formatResultForLog(result)})`
      );
      return;
    }
    const delayMs = Math.min(
      authRetryMaxMs,
      authRetryBaseMs * 2 ** (authRetryAttempt - 1)
    );
    nextAuthRetryAt = Date.now() + delayMs;
    gatewayLog.warn(
      "output-tailer",
      `Retrying output tailer for loopId=${loopId}: attempt=${authRetryAttempt}/${authRetryMaxCount} ${formatResultForLog(result)} backoffMs=${delayMs}`
    );
  }

  async function pollOnce(options?: PollOptions): Promise<void> {
    const ignoreBackoff = options?.ignoreBackoff === true;
    const forceAttempt = options?.forceAttempt === true;
    if (stopped) {
      return;
    }
    if (authRetriesExhausted && !forceAttempt) {
      return;
    }
    if (!ignoreBackoff && nextAuthRetryAt > Date.now()) {
      return;
    }
    const readableJsonlPath = resolveReadableJsonlPath();
    if (readableJsonlPath === null) {
      return;
    }
    if (!updateActiveJsonlPath(readableJsonlPath)) {
      return;
    }
    let fd: number | null = null;
    try {
      fd = openSync(activeJsonlPath, "r");
      const chunkSize = 65_536;
      const chunk = Buffer.alloc(chunkSize);
      let bytesRead: number;
      while (
        (bytesRead = readSync(fd, chunk, 0, chunkSize, readByteOffset)) > 0
      ) {
        readByteOffset += bytesRead;
        pendingRemainder = Buffer.concat([
          pendingRemainder,
          chunk.subarray(0, bytesRead),
        ]);
      }
    } catch {
      return;
    } finally {
      if (fd !== null) {
        closeSync(fd);
      }
    }

    while (!stopped && (!authRetriesExhausted || forceAttempt)) {
      const newlineIndex = pendingRemainder.lastIndexOf(10); // 0x0a
      if (newlineIndex === -1) {
        break;
      }

      const baseInFile = readByteOffset - pendingRemainder.length;
      const framedEndExclusive = baseInFile + newlineIndex + 1;

      const completeLines = pendingRemainder
        .subarray(0, newlineIndex)
        .toString("utf8");
      const suffix = pendingRemainder.subarray(newlineIndex + 1);

      let lastDisplay: string | null = null;
      const frameRecords: Record<string, unknown>[] = [];
      const assistantFrameDelta = emptyTokenTotals();
      for (const line of completeLines.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!isRecord(parsed)) {
          continue;
        }
        frameRecords.push(parsed);
        if (parsed.type === "assistant") {
          const message = isRecord(parsed.message) ? parsed.message : null;
          const usage =
            message !== null && isRecord(message.usage) ? message.usage : null;
          if (usage !== null) {
            assistantFrameDelta.inputTokens +=
              typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
            assistantFrameDelta.outputTokens +=
              typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
            assistantFrameDelta.cacheCreationInputTokens +=
              typeof usage.cache_creation_input_tokens === "number"
                ? usage.cache_creation_input_tokens
                : 0;
            assistantFrameDelta.cacheReadInputTokens +=
              typeof usage.cache_read_input_tokens === "number"
                ? usage.cache_read_input_tokens
                : 0;
          }
        }
        const display = summarizeJsonlRecord(parsed);
        if (!display) {
          continue;
        }
        lastDisplay = display;
      }

      const observeFrame = (): TokenTotals => {
        if (observedFrame?.endExclusive === framedEndExclusive) {
          return observedFrame.nativeFrameDelta;
        }
        const nativeFrameDelta = emptyTokenTotals();
        for (const record of frameRecords) {
          // Native observability sink: derive canonical loop.perf.* events after
          // the throttle gate, caching the delta until this frame commits.
          // Wrapped so a sink failure never stalls the tailer (AC-008).
          if (onJsonlRecord) {
            try {
              const tokenDelta = onJsonlRecord(record);
              if (tokenDelta) {
                nativeFrameDelta.inputTokens += tokenDelta.inputTokens;
                nativeFrameDelta.outputTokens += tokenDelta.outputTokens;
                nativeFrameDelta.cacheCreationInputTokens +=
                  tokenDelta.cacheCreationInputTokens;
                nativeFrameDelta.cacheReadInputTokens +=
                  tokenDelta.cacheReadInputTokens;
              }
            } catch {
              // Observability is best-effort; never block output streaming.
            }
          }
        }
        observedFrame = { endExclusive: framedEndExclusive, nativeFrameDelta };
        return nativeFrameDelta;
      };

      const commitFrame = (nativeFrameDelta: TokenTotals): TokenTotals => {
        const frameDelta = addTokenTotals(
          assistantFrameDelta,
          nativeFrameDelta
        );
        const nextTotals = addTokenTotals(tokenTotals, frameDelta);
        pendingRemainder = suffix;
        tokenTotals = nextTotals;
        if (observedFrame?.endExclusive === framedEndExclusive) {
          observedFrame = null;
        }
        reportCommit(framedEndExclusive);
        return nextTotals;
      };

      if (lastDisplay === null) {
        commitFrame(observeFrame());
        continue;
      }

      const now = Date.now();
      if (lastSentAt !== null && now - lastSentAt < throttleMs) {
        break;
      }

      const nativeFrameDelta = observeFrame();
      const candidateTotals = addTokenTotals(
        tokenTotals,
        addTokenTotals(assistantFrameDelta, nativeFrameDelta)
      );
      const hasAnyTokens = hasAnyTokenTotals(candidateTotals);

      const outputEventBody = {
        type: LoopEventType.Output,
        data: {
          chunk: lastDisplay,
          tokenUsage: hasAnyTokens ? candidateTotals : undefined,
        },
      };
      const result = loopTokenStore
        ? await withTokenRefreshRetry(
            loopId,
            apiBaseUrl,
            getToken,
            loopTokenStore,
            (gt) => postLoopEvent(apiBaseUrl, loopId, gt, outputEventBody)
          )
        : await postLoopEvent(apiBaseUrl, loopId, getToken, outputEventBody);
      if (result.success) {
        resetAuthRetryState();
        authRetriesExhausted = false;
        commitFrame(nativeFrameDelta);
        lastSentAt = now;
        continue;
      }
      if (shouldRetryOnResult(result)) {
        scheduleAuthRetry(result);
      }
      break;
    }
  }

  const intervalId = setInterval(() => {
    if (inFlightPoll !== null) {
      return;
    }
    inFlightPoll = pollOnce().finally(() => {
      inFlightPoll = null;
    });
    inFlightPoll.catch((err) => {
      gatewayLog.error(
        "output-tailer",
        `Poll error for loopId=${loopId}: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }, pollIntervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(intervalId);
    },
    flush: async () => {
      clearInterval(intervalId);
      if (inFlightPoll !== null) {
        await inFlightPoll;
      }
      await pollOnce({ ignoreBackoff: true, forceAttempt: true });
      stopped = true;
    },
  };
}
