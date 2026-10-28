import { redactSecrets } from "@repo/lib/security/redact-secrets";

// Peer context is an evidence product, never a transcript or credential store.
// The wire validator bounds size/depth before this transform is called.
const PRIVATE_FIELD =
  /^(?:transcript|rawtranscript|messages|conversation|conversationhistory|credentials?|password|passwd|secret|apikey|accesstoken|refreshtoken|authorization|cookie|privatekey)$/i;
const FIELD_SEPARATORS = /[_\s-]/g;

/** Shared secret vocabulary; content stays untrusted after redaction. */
export function sanitizeMeshText(value: string): string {
  return redactSecrets(value);
}

/** Remove transcript/credential containers and redact every nested text leaf. */
export function sanitizeMeshContext(
  value: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_FIELD.test(key.replace(FIELD_SEPARATORS, "")))
      .map(([key, item]) => [sanitizeMeshText(key), sanitizeValue(item)])
  );
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeMeshText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value !== null && typeof value === "object") {
    return sanitizeMeshContext(value as Record<string, unknown>);
  }
  return value;
}
