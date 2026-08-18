import { redactSecrets } from "./redact-secrets";

const NEWLINE = "\n";

export const REDACTED_JSONL_TRANSCRIPT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export type RedactedJsonlTranscriptByteAdapterOptions = {
  /**
   * Maximum UTF-8 byte length for any buffered JSONL line, including its
   * terminating newline when present.
   */
  maxLineBytes?: number;
};

export type RedactedJsonlTranscriptFlushResult = {
  /**
   * Redacted chunks produced from any complete lines finalized by the decoder.
   */
  chunks: Uint8Array[];
  /**
   * True when a trailing line fragment without a terminating newline was
   * dropped instead of emitted. The fragment is not returned because it may
   * contain raw secrets.
   */
  droppedPartial: boolean;
};

/**
 * Error thrown when one JSONL transcript line exceeds the configured byte
 * ceiling. Any `chunks` attached to the error have already been redacted and
 * are safe to emit before stopping on the oversized line.
 */
export class RedactedJsonlTranscriptLineTooLongError extends RangeError {
  readonly chunks: Uint8Array[];

  constructor(chunks: Uint8Array[] = []) {
    super("JSONL transcript line exceeds maximum byte length");
    this.name = "RedactedJsonlTranscriptLineTooLongError";
    this.chunks = chunks;
  }
}

/**
 * Incrementally redacts raw JSONL transcript bytes at complete-line boundaries.
 *
 * The adapter is intentionally unaware of `main` vs. `subagent:*` file keys: it
 * only sees transcript bytes, decodes them as UTF-8, buffers the current
 * incomplete line, and emits redacted bytes for complete newline-terminated
 * lines. Secret matching remains delegated to `redactSecrets()` as the SSOT.
 */
export class RedactedJsonlTranscriptByteAdapter {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly maxLineBytes: number;
  private pendingByteLength = 0;
  private pendingText = "";

  constructor(options: RedactedJsonlTranscriptByteAdapterOptions = {}) {
    this.maxLineBytes =
      options.maxLineBytes ?? REDACTED_JSONL_TRANSCRIPT_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1) {
      throw new RangeError("Maximum JSONL transcript line bytes must be >= 1");
    }
  }

  /**
   * Accept one raw transcript byte chunk and return zero or more redacted byte
   * chunks for complete JSONL lines.
   */
  write(chunk: Uint8Array): Uint8Array[] {
    return this.consumeText(this.decoder.decode(chunk, { stream: true }));
  }

  /**
   * Finish the current byte stream. Any unterminated trailing JSONL line remains
   * deferred and is dropped instead of exposed because it may contain raw
   * secrets.
   */
  flush(): RedactedJsonlTranscriptFlushResult {
    const finalText = this.decoder.decode();
    const chunks = finalText ? this.consumeText(finalText) : [];
    const droppedPartial = this.pendingText.length > 0;
    this.pendingText = "";
    return { chunks, droppedPartial };
  }

  private consumeText(text: string): Uint8Array[] {
    if (!text) {
      return [];
    }

    this.pendingText += text;
    this.pendingByteLength += this.encoder.encode(text).byteLength;
    const chunks: Uint8Array[] = [];
    let lineStart = 0;
    let newlineIndex = this.pendingText.indexOf(NEWLINE, lineStart);

    while (newlineIndex !== -1) {
      const lineEnd = newlineIndex + 1;
      const completeLine = this.pendingText.slice(lineStart, lineEnd);
      const completeLineByteLength =
        this.encoder.encode(completeLine).byteLength;
      if (completeLineByteLength > this.maxLineBytes) {
        this.pendingText = "";
        this.pendingByteLength = 0;
        throw new RedactedJsonlTranscriptLineTooLongError(chunks);
      }
      chunks.push(this.encoder.encode(redactSecrets(completeLine)));
      this.pendingByteLength -= completeLineByteLength;
      lineStart = lineEnd;
      newlineIndex = this.pendingText.indexOf(NEWLINE, lineStart);
    }

    this.pendingText = this.pendingText.slice(lineStart);
    if (this.pendingByteLength > this.maxLineBytes) {
      this.pendingText = "";
      this.pendingByteLength = 0;
      throw new RedactedJsonlTranscriptLineTooLongError(chunks);
    }
    return chunks;
  }
}

/**
 * Stream redacted bytes for complete JSONL transcript lines from an iterable
 * source. Any trailing partial line is intentionally deferred and omitted.
 */
export async function* redactJsonlTranscriptByteChunks(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const adapter = new RedactedJsonlTranscriptByteAdapter();
  for await (const chunk of chunks) {
    yield* adapter.write(chunk);
  }
  yield* adapter.flush().chunks;
}
