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
import { parseClaudeTranscript } from "@repo/lib/harness/claude/parse-claude";
import { parseCodexRollout } from "@repo/lib/harness/codex/parse-codex";
import { Harness, type NormalizedSession } from "@repo/lib/harness/types";

/**
 * Harnesses whose parser cores were extracted to `@repo/lib/harness` (FEA-2717
 * Task 1) and can therefore be rendered from the cloud transcript. Cursor,
 * Copilot, and OpenCode still parse only in the desktop main process, so their
 * sessions fall back to the DB-backed renderer.
 */
export function isCloudParseableHarness(harness: string): boolean {
  const normalized = harness.toLowerCase();
  return normalized === Harness.Claude || normalized === Harness.Codex;
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
 * Fetch raw JSONL from a signed S3 URL and parse it into a `NormalizedSession`.
 * Returns null when the harness has no cloud parser or the transcript carries no
 * usable timestamp (the parser's vendor contract). Throws `TranscriptFetchError`
 * on a non-2xx fetch so the caller can distinguish an expired URL from an empty
 * transcript.
 */
export async function fetchAndParseTranscript(input: {
  url: string;
  sessionId: string;
  harness: string;
  signal?: AbortSignal;
}): Promise<NormalizedSession | null> {
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
 */
export function parseTranscriptText(input: {
  harness: string;
  sessionId: string;
  text: string;
}): Promise<NormalizedSession | null> {
  const lines = iterateLines(input.text);
  const normalized = input.harness.toLowerCase();
  if (normalized === Harness.Codex) {
    return parseCodexRollout(lines, { sessionId: input.sessionId });
  }
  if (normalized === Harness.Claude) {
    return parseClaudeTranscript(lines, { sessionId: input.sessionId });
  }
  return Promise.resolve(null);
}

/**
 * Yield JSONL lines from a string without materializing an intermediate array —
 * the parsers already skip blank lines and tolerate a truncated final line.
 */
function* iterateLines(text: string): Generator<string> {
  let start = 0;
  const length = text.length;
  for (let index = 0; index < length; index++) {
    // 10 === "\n"
    if (text.charCodeAt(index) === 10) {
      yield text.slice(start, index);
      start = index + 1;
    }
  }
  if (start < length) {
    yield text.slice(start);
  }
}
