import { LOOP_ACTIVE_INDEX_NAME } from "@/app/loops/loop-constants";

/**
 * Synthesize a Prisma `P2002` error. Defaults to the loops active-index so the
 * service translates it; pass `target: null` (or another constraint name) to
 * simulate a P2002 from a different index. Set `meta` for driver-adapter shapes.
 */
export function makeP2002Error(options?: {
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
  const err = Object.assign(new Error("Unique constraint failed"), {
    code: "P2002" as const,
  });
  const meta = { ...options?.meta };
  if (target !== null) {
    meta.target = target;
  }
  return Object.keys(meta).length > 0 ? Object.assign(err, { meta }) : err;
}
