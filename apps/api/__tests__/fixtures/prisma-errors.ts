/**
 * Helpers for synthesizing Prisma errors in unit tests.
 *
 * The service layer inspects `error.code` plus Prisma/driver-adapter metadata
 * rather than `instanceof PrismaClientKnownRequestError`, so a plain Error
 * decorated with the right code and meta is enough to drive every code path
 * under test.
 */

import { LOOP_ACTIVE_INDEX_NAME } from "@/app/loops/loop-constants";

const ACTIVE_LOOP_P2002_FIELDS = "(`artifact_id`,`command`,`artifact_version`)";
const GENERIC_P2002_FIELDS = "(`id`)";

/**
 * Synthesize a Prisma `P2002` (unique constraint violation). By default the
 * `meta.target` field is set to the loops active-index name so the error is
 * translated by the service. Pass `target: null` (or another constraint name)
 * to simulate a P2002 from a *different* index — the service should leave it
 * alone.
 */
export function makeP2002Error(options?: {
  fields?: string;
  meta?: Record<string, unknown>;
  target?: string | string[] | null;
}): Error & {
  code: "P2002";
  meta?: Record<string, unknown> & { target?: string | string[] };
} {
  const target =
    options === undefined || options.target === undefined
      ? LOOP_ACTIVE_INDEX_NAME
      : options.target;
  const fields =
    options?.fields ??
    (target === LOOP_ACTIVE_INDEX_NAME
      ? ACTIVE_LOOP_P2002_FIELDS
      : GENERIC_P2002_FIELDS);
  const err = new Error(`Unique constraint failed on the fields: ${fields}`);
  const decorated = Object.assign(err, { code: "P2002" as const });
  const meta = { ...options?.meta };
  if (target !== null) {
    meta.target = target;
  }
  if (Object.keys(meta).length > 0) {
    return Object.assign(decorated, { meta });
  }
  return decorated;
}
