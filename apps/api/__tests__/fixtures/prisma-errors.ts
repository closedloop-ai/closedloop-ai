/**
 * Helpers for synthesizing Prisma errors in unit tests.
 *
 * The service layer inspects `error.code` (a duck-typed check) rather than
 * `instanceof PrismaClientKnownRequestError`, so a plain Error decorated with
 * the right code is enough to drive every code path under test.
 */

/** Synthesize a Prisma `P2002` (unique constraint violation). */
export function makeP2002Error(
  fields = "(`artifact_id`,`command`)"
): Error & { code: "P2002" } {
  const err = new Error(`Unique constraint failed on the fields: ${fields}`);
  return Object.assign(err, { code: "P2002" as const });
}
