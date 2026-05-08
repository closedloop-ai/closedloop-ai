import "server-only";

import { isTrustedOrigin } from "@/lib/trusted-origins";

/**
 * Returns a canonical trusted origin string or null when the input is untrusted
 * or not already in bare origin form.
 */
export function canonicalizeTrustedOrigin(origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }

  if (parsed.origin !== origin) {
    return null;
  }

  return isTrustedOrigin(parsed.origin) ? parsed.origin : null;
}
