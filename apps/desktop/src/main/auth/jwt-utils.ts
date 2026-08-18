/**
 * Extracts the `exp` claim from a JWT payload via manual base64url splitting.
 *
 * Returns the `exp` value (Unix timestamp in seconds) if present and numeric,
 * or `null` for malformed tokens or missing `exp`.
 */
export function parseJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const payloadB64 = parts[1];

  let json: string;
  try {
    // Normalize base64url to base64 before decoding.
    const base64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    json = Buffer.from(base64, "base64").toString("utf8");
  } catch {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }

  const { exp } = payload as Record<string, unknown>;
  if (typeof exp !== "number") {
    return null;
  }

  return exp;
}
