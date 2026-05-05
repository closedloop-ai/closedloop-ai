/**
 * Helpers for synthesizing Prisma errors in unit tests.
 *
 * The service layer inspects `error.code` and `error.meta.target` rather than
 * `instanceof PrismaClientKnownRequestError`, so a plain Error decorated with
 * the right code and meta is enough to drive every code path under test.
 */

import { LOOP_ACTIVE_INDEX_NAME } from "@/app/loops/loop-constants";

/**
 * Synthesize a Prisma `P2002` (unique constraint violation). By default the
 * `meta.target` field is set to the loops active-index name so the error is
 * translated by the service. Pass `target: null` (or another constraint name)
 * to simulate a P2002 from a *different* index — the service should leave it
 * alone.
 */
export function makeP2002Error(options?: {
  fields?: string;
  target?: string | string[] | null;
}): Error & {
  code: "P2002";
  meta?: { target?: string | string[] };
} {
  const fields = options?.fields ?? "(`artifact_id`,`command`)";
  const target =
    options === undefined || options.target === undefined
      ? LOOP_ACTIVE_INDEX_NAME
      : options.target;
  const err = new Error(`Unique constraint failed on the fields: ${fields}`);
  const decorated = Object.assign(err, { code: "P2002" as const });
  if (target !== null) {
    return Object.assign(decorated, { meta: { target } });
  }
  return decorated;
}
