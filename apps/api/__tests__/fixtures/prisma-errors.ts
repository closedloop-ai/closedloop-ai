import { LOOP_ACTIVE_INDEX_NAME } from "@/app/loops/loop-constants";

/**
 * Synthesize a Prisma known-request error for any code.
 *
 * `getPrismaErrorCode` (`lib/db-utils.ts`) reads `.code` off the caught value,
 * so that field is what every consumer actually branches on — but `.name` is
 * set too, because a test that only ever sees an anonymous `Error` cannot catch
 * a consumer that starts narrowing on the real error class.
 *
 * This is the single constructor for the shape: `makeP2002Error` below and the
 * write-semantics delegate double both route through it, so a future change to
 * how Prisma surfaces errors lands in one place instead of drifting between
 * fixtures.
 */
export function makePrismaKnownRequestError(
  code: string,
  message: string,
  meta?: Record<string, unknown>
): Error & { code: string; meta?: Record<string, unknown> } {
  const err = Object.assign(new Error(message), { code });
  err.name = "PrismaClientKnownRequestError";
  return meta === undefined ? err : Object.assign(err, { meta });
}

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
  const err = makePrismaKnownRequestError(
    "P2002",
    "Unique constraint failed"
  ) as Error & { code: "P2002" };
  const meta: Record<string, unknown> = { ...options?.meta };
  if (target !== undefined) {
    // null is set explicitly (pg-adapter shape); non-null values set normally.
    meta.target = target;
  }
  return Object.keys(meta).length > 0 ? Object.assign(err, { meta }) : err;
}
