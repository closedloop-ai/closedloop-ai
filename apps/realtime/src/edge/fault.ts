/**
 * What a fault log may carry about an error: an `Error`'s own message only.
 * A client can emit an `error` event itself, and its arguments are payload
 * content, which never reaches a log.
 */
export function describeFault(error: unknown): string {
  return error instanceof Error ? error.message : typeof error;
}
