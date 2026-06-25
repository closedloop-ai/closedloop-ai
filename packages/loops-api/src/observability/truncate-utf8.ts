/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes without splitting
 * multi-byte characters. Walks backward past continuation bytes (0x80..0xBF)
 * to find the last complete codepoint boundary.
 *
 * SSOT for the loop telemetry/observability pipeline (desktop main + apps/api).
 * Re-exported by `@repo/observability/truncate-utf8` for existing consumers.
 */
export function truncateUtf8(input: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(input);
  if (encoded.length <= maxBytes) {
    return input;
  }
  let end = maxBytes;
  // biome-ignore lint/suspicious/noBitwiseOperators: UTF-8 continuation byte detection requires bitwise AND
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) {
    end--;
  }
  return new TextDecoder().decode(encoded.subarray(0, end));
}
