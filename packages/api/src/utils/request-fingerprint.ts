import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";

/**
 * ISS-12552: the fallback join between a transcript tool call and its server
 * receipt, for harnesses that send no per-call id. `apps/mcp` hashes the raw
 * tool arguments it received and Desktop hashes the arguments the transcript
 * recorded, so both sides must call this one function. Key order never
 * changes the result. No argument text is kept, only the digest.
 */
export const REQUEST_FINGERPRINT_VERSION = 1 as const;

/** Lowercase hex sha256 over the tool name and its canonical arguments. */
export async function computeRequestFingerprint(
  toolName: string,
  args: unknown
): Promise<string> {
  const canonical = [
    REQUEST_FINGERPRINT_VERSION,
    toolName,
    stableStringify(args ?? {}),
  ].join("\u0000");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
