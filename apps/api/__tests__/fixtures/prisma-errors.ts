import { LOOP_ACTIVE_INDEX_NAME } from "@/app/loops/loop-constants";

/**
 * Synthesize a Prisma `P2002` error.
 *
 * - `target` defaults to the loops active-index name (string).
 * - Pass `target: undefined` (or omit) to get the default index target.
 * - Pass `target: null` to emit `meta: { target: null, ... }`, which reproduces
 *   the pg-adapter shape where `driverAdapterError` carries the constraint info
 *   and `target` is explicitly null.
 * - Pass any other string or string[] to simulate a P2002 from a different index.
 * - `meta` fields are merged on top of (or in place of) the default `target`.
 */
export function makeP2002Error(options?: {
  meta?: Record<string, unknown>;
  target?: string | string[] | null;
}): Error & {
  code: "P2002";
  meta?: Record<string, unknown> & { target?: string | string[] | null };
} {
  const target =
    options === undefined || options.target === undefined
      ? LOOP_ACTIVE_INDEX_NAME
      : options.target;
  const err = Object.assign(new Error("Unique constraint failed"), {
    code: "P2002" as const,
  });
  const meta: Record<string, unknown> = { ...options?.meta };
  if (target !== undefined) {
    // null is set explicitly (pg-adapter shape); non-null values set normally.
    meta.target = target;
  }
  return Object.keys(meta).length > 0 ? Object.assign(err, { meta }) : err;
}
