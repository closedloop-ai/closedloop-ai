/**
 * Byte and base64 conversion for renderer code that has to carry binary over a
 * JSON-only channel. The renderer has no `Buffer`, and the `Uint8Array` base64
 * methods are not in the renderer's `ES2023` lib.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Spread in slices: one `fromCharCode` per byte took about twice as long on a
  // 25 MiB buffer in V8, and spreading the whole array overflows the argument
  // limit.
  for (let offset = 0; offset < bytes.length; offset += CHAR_CODE_SLICE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + CHAR_CODE_SLICE)
    );
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const CHAR_CODE_SLICE = 0x80_00;
