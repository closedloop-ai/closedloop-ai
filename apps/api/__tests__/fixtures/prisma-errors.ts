/**
 * Synthesize a Prisma known-request error for any code.
 *
 * `getPrismaErrorCode` (`lib/db-utils.ts`) reads `.code` off the caught value,
 * so that field is what every consumer actually branches on — but `.name` is
 * set too, because a test that only ever sees an anonymous `Error` cannot catch
 * a consumer that starts narrowing on the real error class.
 *
 * This is the single constructor for the shape: every fixture that needs a
 * Prisma error routes through it, so a future change to
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
