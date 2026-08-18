/**
 * FEA-2717 (PLN-1290): fetch a session's raw JSONL transcript from its
 * short-lived signed S3 URL and parse it — in the browser — with the SAME
 * harness parser cores the desktop DB importer runs (`@repo/lib/harness`), so
 * there is zero interpretation divergence between the cloud-rendered transcript
 * and the DB-backed one.
 *
 * Pure and surface-agnostic (no React, no auth): the hook layer
 * (`use-session-transcript`) owns descriptor fetching, caching, and gating.
 */
import { parseClaudeTranscript } from "@repo/lib/harness/claude/parse-claude-core";
import { parseCodexRollout } from "@repo/lib/harness/codex/parse-codex";
import { parseOpenCodeTranscript } from "@repo/lib/harness/opencode/parse-opencode";
import {
  Harness,
  type NormalizedApiError,
  type NormalizedMessage,
  type NormalizedPlan,
  type NormalizedSession,
  type NormalizedSkillUse,
  type NormalizedSubagent,
  type NormalizedToolResultError,
  type NormalizedToolUse,
} from "@repo/lib/harness/types";
import { redactSecrets } from "@repo/lib/security/redact-secrets";

/**
 * Harnesses the cloud transcript renderer can parse. Claude and Codex parse
 * their raw on-disk transcripts directly (FEA-2717 Task 1). OpenCode (FEA-3932)
 * is a BATCH harness whose foreign `opencode.db` the desktop materializes into a
 * line-delimited JSON projection; the cloud reads that projection back with the
 * SHARED record schema, so an OpenCode session with a synced materialized file
 * renders in the cloud too. Cursor and Copilot still parse only in the desktop
 * main process, so their sessions fall back to the DB-backed renderer.
 */
export function isCloudParseableHarness(harness: string): boolean {
  const normalized = harness.toLowerCase();
  return (
    normalized === Harness.Claude ||
    normalized === Harness.Codex ||
    normalized === Harness.OpenCode
  );
}

/** A non-2xx response fetching the signed transcript URL (e.g. an expired URL). */
export class TranscriptFetchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TranscriptFetchError";
    this.status = status;
  }
}

/**
 * The archived bytes were fetched successfully, but the harness parser threw
 * while turning them into a `NormalizedSession`. Kept distinct from
 * `TranscriptFetchError` so the UI can tell "the archive is missing/expired/403"
 * (a fresh fetch may recover) from "we have the bytes but can't parse them" (a
 * Retry re-fetches the SAME bytes and fails identically — a code bug, not a
 * transient gap). The concrete trigger seen in the wild: a non-Claude harness
 * rollout (Codex/gpt-*) whose token-usage event carries a fractional or
 * JS-unsafe counter, tripping the parser's `InvalidTokenCountError` guard. The
 * original parser error is preserved as `cause` for logging. FEA follow-up:
 * teach the parser to tolerate such values rather than abort the whole render.
 */
export class TranscriptParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TranscriptParseError";
  }
}

/**
 * Internal marker wrapping a failure of the DOWNLOAD stream (an aborted fetch, a
 * dropped connection) as opposed to a failure of the PARSER. When lines are
 * streamed straight into the parser core (FEA-3714) both failures surface at the
 * same `for await` site, so without this tag a cancel/network drop would be
 * mis-reported as a `TranscriptParseError` ("bytes present but unparseable") and
 * an aborted read would no longer read as a clean cancel to React Query. The
 * parse dispatcher unwraps this and rethrows the original error untouched, so
 * stream/abort errors keep propagating raw exactly as the buffered path did.
 * Never exported — callers only ever see the wrapped `original` error. The
 * original is held in an explicit field (not the optional `Error.cause`) so the
 * unwrap never depends on the runtime having set the `cause` option.
 */
class TranscriptStreamReadError extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super("Transcript download stream failed.");
    this.name = "TranscriptStreamReadError";
    this.original = original;
  }
}

/**
 * Out-of-band channel for a download-stream failure while lines are streamed into
 * the parser (FEA-3714). The parser core's own `try/catch` may swallow the thrown
 * iterator error and return null, so the failure is also recorded here and
 * re-checked after the parse so an aborted/dropped download surfaces raw.
 */
type StreamReadState = { error?: { value: unknown } };

/**
 * Progress of an in-flight transcript download, reported per chunk while the
 * body streams (FEA-3447). `total` is the archive size from `Content-Length`, or
 * null when the server omits it (an indeterminate download — bytes only, no
 * percent). Surfaced so the deferred/oversized "Load full transcript" gate can
 * show percent/bytes instead of a bare spinner.
 */
export type TranscriptDownloadProgress = {
  loaded: number;
  total: number | null;
};

/**
 * Fetch raw JSONL from a signed S3 URL and parse it into a `NormalizedSession`.
 * Returns null when the harness has no cloud parser or the transcript carries no
 * usable timestamp (the parser's vendor contract). Throws `TranscriptFetchError`
 * on a non-2xx fetch and `TranscriptParseError` if the parser throws on the
 * fetched bytes, so the caller can distinguish an expired/missing archive from a
 * parse failure (and from an empty transcript, which returns null).
 *
 * When `onProgress` is supplied the body is streamed (a large transcript can be
 * up to the 25 MB auto-load cap, or a ~275 MB local outlier), reporting bytes as
 * they arrive so the UI can show download progress + a cancel; the `signal` is
 * threaded into the fetch so aborting it (cancel / unmount) stops the download
 * mid-stream. On that streaming path the decoded lines flow STRAIGHT into the
 * harness parser core as they arrive (FEA-3714) — the whole-file string is never
 * materialized, so a very large upload no longer costs a duplicate whole-file
 * string on top of the parsed session (bounded peak memory), and the parser's
 * per-line pull provides natural backpressure on the reader. Output stays
 * byte-identical to batch parsing regardless of where chunk boundaries fall.
 *
 * Without `onProgress` (or when the body exposes no readable stream, e.g. some
 * `app://` desktop responses) the read falls back to buffering `response.text()`,
 * byte-identical to the original behaviour.
 */
export async function fetchAndParseTranscript(input: {
  url: string;
  sessionId: string;
  harness: string;
  signal?: AbortSignal;
  onProgress?: (progress: TranscriptDownloadProgress) => void;
}): Promise<NormalizedSession | null> {
  // A harness with no cloud parser can never yield a session, so short-circuit
  // BEFORE any fetch/stream work. Opening the streaming read only to have
  // `parseHarnessLines` return null would abandon the response body mid-download
  // (the reader is never drained, leaking the connection). Checking here keeps
  // an unsupported harness off the streaming path entirely rather than opening a
  // stream it won't consume. Behaviour is otherwise unchanged: the buffered path
  // already returned null for these harnesses.
  if (!isCloudParseableHarness(input.harness)) {
    return null;
  }
  const response = await fetch(
    input.url,
    input.signal ? { signal: input.signal } : undefined
  );
  if (!response.ok) {
    throw new TranscriptFetchError(
      response.status,
      `Failed to fetch transcript (HTTP ${response.status}).`
    );
  }
  const body = response.body;
  if (input.onProgress && body) {
    // Stream chunks directly into the incremental parser — never buffer the
    // whole file. `readState` records a download-stream failure so it can be
    // surfaced raw even though the parser core's broad catch may swallow the
    // thrown iterator error and return a null/partial session: an aborted or
    // dropped download must read as a cancel, not a silent empty parse.
    const readState: StreamReadState = {};
    const session = await parseHarnessLines({
      harness: input.harness,
      sessionId: input.sessionId,
      lines: streamResponseLines(response, body, input.onProgress, readState),
    });
    if (readState.error) {
      throw readState.error.value;
    }
    return session;
  }
  const text = await response.text();
  return parseTranscriptText({
    harness: input.harness,
    sessionId: input.sessionId,
    text,
  });
}

/**
 * Parse an in-memory JSONL string with the harness-appropriate core. Split out
 * from the fetch so tests (and any future web-worker host) can exercise parsing
 * without a network round-trip.
 *
 * Any parser throw is re-raised as a `TranscriptParseError` (preserving the
 * original as `cause`) so a fetch failure and a parse failure never collapse
 * into one indistinguishable error at the call site. This is deliberately NOT a
 * silent swallow: an empty/unparseable transcript still surfaces to the user —
 * but as an accurate "couldn't parse" state, and the surface can render whatever
 * the partial parse produced instead of a blank generic error.
 */
export function parseTranscriptText(input: {
  harness: string;
  sessionId: string;
  text: string;
}): Promise<NormalizedSession | null> {
  return parseHarnessLines({
    harness: input.harness,
    sessionId: input.sessionId,
    lines: iterateLines(input.text),
  });
}

/**
 * Dispatch a line stream to the harness-appropriate parser core. Shared by the
 * in-memory (`parseTranscriptText`) and streaming (`fetchAndParseTranscript`)
 * paths so both apply the identical harness routing and error-tagging contract.
 * The `lines` may be a sync iterable (a whole-string split) or an async one (the
 * download stream) — the cores consume either the same way, so a streamed parse
 * yields output identical to a batch parse of the same bytes.
 *
 * Any parser throw is re-raised as a `TranscriptParseError` (preserving the
 * original as `cause`) so a fetch failure and a parse failure never collapse into
 * one indistinguishable error at the call site — e.g. an `InvalidTokenCountError`
 * on a novel Codex/gpt-* token shape reads as "bytes present but unparseable",
 * not "the archive is gone." A failure of the download stream itself arrives
 * wrapped in `TranscriptStreamReadError` and is rethrown UNwrapped, so an aborted
 * download still surfaces as its raw abort error (a clean cancel), never as a
 * parse failure.
 */
async function parseHarnessLines(input: {
  harness: string;
  sessionId: string;
  lines: AsyncIterable<string> | Iterable<string>;
}): Promise<NormalizedSession | null> {
  const normalized = input.harness.toLowerCase();
  try {
    let session: NormalizedSession | null;
    if (normalized === Harness.Codex) {
      session = await parseCodexRollout(input.lines, {
        sessionId: input.sessionId,
      });
    } else if (normalized === Harness.Claude) {
      session = await parseClaudeTranscript(input.lines, {
        sessionId: input.sessionId,
      });
    } else if (normalized === Harness.OpenCode) {
      session = await parseOpenCodeTranscript(input.lines, {
        sessionId: input.sessionId,
      });
    } else {
      session = null;
    }
    return session ? redactNormalizedSession(session) : null;
  } catch (error) {
    if (error instanceof TranscriptStreamReadError) {
      throw error.original;
    }
    throw new TranscriptParseError(
      error instanceof Error
        ? `Failed to parse the archived transcript: ${error.message}`
        : "Failed to parse the archived transcript.",
      { cause: error }
    );
  }
}

/**
 * Viewer-boundary defense-in-depth for already archived/raw transcript bytes.
 * Redact after parser concatenation so Codex/Claude block assembly cannot
 * reconstruct a secret that was split across serialized JSONL content blocks.
 * This keeps S3/local cache bytes, hashes, cursors, and upload contracts
 * untouched while ensuring rendered projections receive redacted text.
 */
function redactNormalizedSession(
  session: NormalizedSession
): NormalizedSession {
  return {
    ...session,
    messages: session.messages.map(redactMessage),
    toolUses: session.toolUses.map(redactToolUse),
    subagents: session.subagents?.map(redactSubagent),
    plans: session.plans?.map(redactPlan),
    apiErrors: session.apiErrors.map(redactApiError),
    toolResultErrors: session.toolResultErrors.map(redactToolResultError),
    skills: session.skills.map(redactSkillUse),
  };
}

function redactMessage(message: NormalizedMessage): NormalizedMessage {
  return {
    ...message,
    text: redactRequiredNullableString(message.text),
    model: redactNullableString(message.model),
  };
}

function redactToolUse(toolUse: NormalizedToolUse): NormalizedToolUse {
  const redacted: NormalizedToolUse = {
    ...toolUse,
    name: redactSecrets(toolUse.name),
    gitBranch: redactNullableString(toolUse.gitBranch),
  };
  if (toolUse.mcpServer !== undefined) {
    redacted.mcpServer = redactSecrets(toolUse.mcpServer);
  }
  if (toolUse.mcpMethod !== undefined) {
    redacted.mcpMethod = redactSecrets(toolUse.mcpMethod);
  }
  if (toolUse.skillName !== undefined) {
    redacted.skillName = redactSecrets(toolUse.skillName);
  }
  if (toolUse.input !== undefined) {
    redacted.input = redactUnknownStrings(toolUse.input);
  }
  if (toolUse.output !== undefined) {
    redacted.output = redactUnknownStrings(toolUse.output);
  }
  return redacted;
}

function redactSubagent(subagent: NormalizedSubagent): NormalizedSubagent {
  return {
    ...subagent,
    name: redactSecrets(subagent.name),
    type: redactNullableString(subagent.type),
    task: redactNullableString(subagent.task),
    status: redactNullableString(subagent.status),
    toolUses: subagent.toolUses?.map(redactToolUse),
    metadata: subagent.metadata
      ? redactRecordStrings(subagent.metadata)
      : subagent.metadata,
  };
}

function redactSkillUse(skillUse: NormalizedSkillUse): NormalizedSkillUse {
  return {
    ...skillUse,
    name: redactSecrets(skillUse.name),
  };
}

function redactPlan(plan: NormalizedPlan): NormalizedPlan {
  return {
    ...plan,
    source: redactNullableString(plan.source),
    content: redactNullableString(plan.content),
  };
}

function redactApiError(error: NormalizedApiError): NormalizedApiError {
  return {
    ...error,
    type: redactNullableString(error.type),
    message: redactNullableString(error.message),
  };
}

function redactToolResultError(
  error: NormalizedToolResultError
): NormalizedToolResultError {
  return {
    ...error,
    content: redactNullableString(error.content),
  };
}

function redactNullableString(value: string | null | undefined): typeof value {
  return typeof value === "string" ? redactSecrets(value) : value;
}

function redactRequiredNullableString(value: string | null): string | null {
  return typeof value === "string" ? redactSecrets(value) : value;
}

function redactUnknownStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactUnknownStrings);
  }
  if (isRecord(value)) {
    return redactRecordStrings(value);
  }
  return value;
}

function redactRecordStrings(
  value: Record<string, unknown>
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactUnknownStrings(entry);
  }
  return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * The one lower-level newline splitter shared by every JSONL line source in this
 * file (the in-memory `iterateLines` and the streaming `streamResponseLines`),
 * so the "scan a chunk for `\n` and re-join a record split across a boundary"
 * logic lives in exactly one place. Given a `carry` (the unterminated tail left
 * over from the previous chunk) and the next decoded `chunk`, it yields each
 * complete line — carry prepended to the first — and returns the new carry (the
 * trailing bytes after the last newline). The caller decides what to do with the
 * final carry (yield it as a partial tail, or drop an empty one), mirroring the
 * "tolerate a truncated final line, skip a trailing blank" contract the parsers
 * expect. A newline (`0x0A`) is a single ASCII byte and never part of a
 * multi-byte UTF-8 sequence, so splitting per chunk yields exactly the same
 * lines as splitting the fully-concatenated text.
 */
function* splitChunkLines(
  carry: string,
  chunk: string
): Generator<string, string> {
  let pending = carry;
  let start = 0;
  for (let index = 0; index < chunk.length; index++) {
    // 10 === "\n"
    if (chunk.charCodeAt(index) === 10) {
      yield pending + chunk.slice(start, index);
      pending = "";
      start = index + 1;
    }
  }
  return pending + chunk.slice(start);
}

/**
 * Yield JSONL lines from a whole string without materializing an intermediate
 * array — the parsers already skip blank lines and tolerate a truncated final
 * line. A single-chunk application of `splitChunkLines`: the returned carry is
 * the final partial tail, yielded only when non-empty.
 */
function* iterateLines(text: string): Generator<string> {
  const carry = yield* splitChunkLines("", text);
  if (carry.length > 0) {
    yield carry;
  }
}

/**
 * Decode a streaming response body into JSONL lines, yielding each complete line
 * as soon as its terminating newline arrives so the parser consumes the file
 * incrementally instead of after a whole-file buffer (FEA-3714). Byte progress is
 * reported per chunk exactly as the previous buffered reader did, so the download
 * UI is unchanged.
 *
 * Chunk-boundary safety — the produced line sequence is identical to
 * `iterateLines` over the fully-concatenated text for ANY chunking:
 * - A newline (`0x0A`) is a single ASCII byte, never part of a multi-byte UTF-8
 *   sequence, so a chunk split can never hide or fabricate a line break.
 * - `carry` holds the trailing bytes of a record split across a chunk boundary
 *   and prepends them to the next chunk, so a JSONL record re-joins exactly.
 * - `decoder.decode(value, { stream: true })` keeps a multi-byte codepoint split
 *   across chunks intact.
 * - The final `carry` (a partial tail with no trailing newline) is yielded last,
 *   and an empty trailing `carry` is NOT yielded — mirroring `iterateLines`.
 *
 * Backpressure & memory: the consumer pulls one line at a time, so the reader
 * only advances when the parser is ready, and at most one chunk plus the small
 * carry is held at once — never the whole file.
 *
 * A failure of the read itself (aborted fetch, dropped connection) is wrapped in
 * `TranscriptStreamReadError` so the parse dispatcher can rethrow it raw rather
 * than mis-tag it as a parse failure; an aborted download therefore still
 * surfaces as its original abort error (a clean cancel).
 */
async function* streamResponseLines(
  response: Response,
  body: ReadableStream<Uint8Array>,
  onProgress: (progress: TranscriptDownloadProgress) => void,
  readState: StreamReadState
): AsyncGenerator<string> {
  const total = resolveDownloadTotal(response);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let loaded = 0;
  let carry = "";
  onProgress({ loaded, total });
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        // A stream/read failure is NOT a parse failure — record it (the parser
        // core may swallow the throw and return null) and tag the throw so the
        // parse dispatcher rethrows the original (an AbortError stays a cancel).
        readState.error = { value: error };
        throw new TranscriptStreamReadError(error);
      }
      if (result.done) {
        break;
      }
      loaded += result.value.byteLength;
      const chunk = decoder.decode(result.value, { stream: true });
      // Same newline splitter the in-memory path uses; `carry` re-joins a record
      // straddling this chunk boundary with the next chunk's leading bytes.
      carry = yield* splitChunkLines(carry, chunk);
      onProgress({ loaded, total });
    }
    // Flush any buffered multi-byte remainder into the final partial line.
    carry += decoder.decode();
    // Always land on a terminal event at the true downloaded size so the bar
    // reaches 100% and the final bytes are never dropped by the progress throttle
    // — even when the streamed byte count differs from `Content-Length` (a short
    // read), or there was no `Content-Length` at all.
    onProgress({
      loaded,
      total: total != null && loaded >= total ? total : loaded,
    });
    if (carry.length > 0) {
      yield carry;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The byte total to measure download progress against, or null (indeterminate).
 * A compressed response reports the COMPRESSED size in `Content-Length` while the
 * reader yields DECODED bytes (the browser transparently inflates it), so the
 * header can't measure the decoded download — fall back to a bytes-only display.
 */
function resolveDownloadTotal(response: Response): number | null {
  if (response.headers.get("Content-Encoding")) {
    return null;
  }
  return parseContentLength(response.headers.get("Content-Length"));
}

/** Parse a `Content-Length` header into a positive byte total, or null. */
function parseContentLength(header: string | null): number | null {
  if (!header) {
    return null;
  }
  const total = Number.parseInt(header, 10);
  return Number.isFinite(total) && total > 0 ? total : null;
}
