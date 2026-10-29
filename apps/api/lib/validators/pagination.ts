import { z } from "zod";

/**
 * A page bound is absent or a real number — never a present-but-blank string.
 * `z.coerce.number()` reads `?limit=` as 0, which `clampPageLimit` turns into a
 * one-row page, so the response would state a bound the caller never sent.
 *
 * Canonical for the clamp-style page-bound policy — parse leniently, then bound
 * both ends and serve the nearest legal page — so the surfaces that share it
 * cannot drift into different page caps. It is not the only page-bound policy on
 * this API, and adopting it is a choice: `projects/[id]/tree` deliberately does
 * NOT use it, because it REJECTS a malformed bound rather than clamping it, and
 * parses integers only.
 */
export const pageBoundValidator = z
  .string()
  .trim()
  .min(1, "must not be blank")
  .pipe(z.coerce.number())
  .optional();

/**
 * Bring a caller-supplied offset inside a surface's bounds, at BOTH ends.
 *
 * The ceiling is not decoration: the provider rejects an absurd offset, that
 * rejection surfaces as a thrown SDK error, and the route turns it into a
 * provider-unavailable response plus an error-level log — a caller mistake
 * reported as a provider outage, and a log line any authenticated caller could
 * drive on demand. Clamping keeps a bad offset an empty page, which is the
 * truthful answer.
 */
export function clampPageOffset(
  raw: number | undefined,
  maxOffset: number
): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return 0;
  }
  return Math.min(Math.max(0, Math.floor(raw)), maxOffset);
}
