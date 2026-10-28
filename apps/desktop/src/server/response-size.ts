/**
 * Byte accounting for gateway response chunks, used by `GatewayRouter.handle`
 * to size the `GatewayActivityEvent` it emits per request.
 *
 * Extracted from `router.ts` (ISS-7958) so that file — which is on the
 * shrink-only `noExcessiveLinesPerFile` grandfather list in `biome.jsonc` —
 * stays under its committed line count. Body is unchanged from the original.
 */
export function byteLengthOfResponseChunk(
  chunk: unknown,
  encoding: unknown
): number {
  if (typeof chunk === "string") {
    return Buffer.byteLength(
      chunk,
      typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8"
    );
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.byteLength;
  }
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }
  return 0;
}
