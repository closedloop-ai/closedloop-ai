"use client";

/**
 * Encodes browser Web Crypto byte buffers as base64 without relying on Node-only
 * Buffer APIs.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
