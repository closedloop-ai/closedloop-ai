/**
 * A loggable cause for a failure: the error's `code` (a driver or SQLSTATE
 * vocabulary word) or else its class name. Never the message, which can carry
 * a host name, a connection string or a token.
 */
export function describeCause(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" && code.length > 0 ? code : error.name;
}
