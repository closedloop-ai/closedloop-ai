import type { POST } from "@/app/preview-schemas/ensure/route";

/** The branch every preview-schema route suite probes with. */
export const PROBE_BRANCH = "iss-4489-probe";

/**
 * `base` padded with a key the route validators strip, sized so the serialized
 * payload is exactly `bytes` long — the only way to probe a body cap AT its
 * limit as well as one past it. Every character is ASCII, so the JSON string's
 * length is its UTF-8 byte length and `readCappedRequestText` counts what this
 * counts.
 *
 * Throws rather than letting `String.repeat` raise `RangeError: Invalid count
 * value`, so a cap lowered under the envelope names its own cause.
 */
export function bodyOfBytes(
  base: Record<string, unknown>,
  bytes: number
): Record<string, unknown> {
  const padLength = bytes - JSON.stringify({ ...base, pad: "" }).length;
  if (padLength < 0) {
    throw new Error(
      `Cannot build a ${bytes}-byte body: the envelope for ${JSON.stringify(base)} already exceeds it`
    );
  }
  return { ...base, pad: "x".repeat(padLength) };
}

/** The bearer header a valid ensure request carries; the OIDC check is mocked. */
export const OIDC_HEADER = "Bearer test-oidc-token";

/** A POST to `/preview-schemas/ensure` carrying `body`, as the route receives it. */
export function ensureRequest(
  body: unknown,
  headers: Record<string, string> = { authorization: OIDC_HEADER }
) {
  const request = new Request(
    "https://api.stage.example/preview-schemas/ensure",
    { method: "POST", body: JSON.stringify(body), headers }
  );
  return request as Parameters<typeof POST>[0];
}
