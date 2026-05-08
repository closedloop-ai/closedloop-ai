/**
 * Creates a ReadableStreamDefaultReader from raw string chunks.
 * Shared across stream-related test files.
 */
export function createReader(
  chunks: string[]
): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return stream.getReader();
}
