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

const BASE64_PADDING_REGEX = /=+$/;

/**
 * Encodes byte buffers as base64url (RFC 4648 §5) without padding, as used by
 * Desktop command-signing fingerprints and hashes.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(BASE64_PADDING_REGEX, "");
}
