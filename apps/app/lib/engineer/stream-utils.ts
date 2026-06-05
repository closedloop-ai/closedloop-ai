/**
 * Shared NDJSON (newline-delimited JSON) stream reader utility.
 *
 * Used by terminal-stream.ts and chat-utils.ts to avoid duplicating the
 * buffering and line-splitting logic for reading streamed responses.
 */
export async function* readNdjsonLines(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        yield line;
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }

  // Flush decoder and yield any trailing content without a newline terminator.
  buffer += decoder.decode();
  const remaining = buffer.trim();
  if (remaining) {
    yield remaining;
  }
}
