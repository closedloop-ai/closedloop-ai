/**
 * Next types the value it hands an error boundary as `unknown`
 * (`ErrorInfo.error` in `next/dist/client/components/error-boundary`, with a
 * `TODO(NAR-804)` saying so), while the `error.tsx` file convention documents
 * it as an `Error`. Both root boundaries declared the documented type, so a
 * `throw "string"`, `throw { code: 500 }` or `throw null` from anywhere in the
 * authenticated app reached them as a value the declaration said was
 * impossible — and `error.digest` on `null` throws inside the crash handler,
 * which is a blank page for the whole app (ISS-6995).
 *
 * The boundaries narrow here instead of casting: a real `Error` is passed
 * through by IDENTITY, so what the reporter receives for every error the app
 * has ever produced is byte-for-byte what it received before.
 */
const NON_ERROR_THROWN_NAME = "NonErrorThrown";

/**
 * The thrown value as something the RUM reporter can carry.
 *
 * A non-`Error` cannot supply a message, so none is invented: the synthesized
 * message states only the value's type, which is all that is known about it.
 * The raw value is deliberately NOT interpolated — a thrown string can carry
 * user-entered text, and `dd_context` is an allowlist for the same reason
 * (`sanitizeContext`).
 *
 * NOTHING is read off a non-`Error`, and the `digest` is why. Reading one from
 * an untrusted value defeats both halves of this helper's job:
 *
 *  - the READ can throw. A thrown object can put a getter on `digest`, and a
 *    getter that throws does so inside the boundary's reporting effect — which
 *    is the blank page this helper exists to prevent (whitlockk).
 *  - the VALUE cannot be trusted. `reportNextjsError` DROPS an error whose
 *    digest starts with `NEXT_HTTP_ERROR_FALLBACK;` or `NEXT_REDIRECT`, so a
 *    plain object carrying a forged digest silently suppresses a real error,
 *    and that same unvalidated string is handed to Datadog (davetho).
 *
 * Control-flow filtering is unaffected: `notFound()` and `redirect()` throw real
 * `Error` instances, which take the identity branch above with their digests
 * intact. `digest` stays on the return type for exactly those.
 */
export function toReportableError(
  thrown: unknown
): Error & { digest?: string } {
  if (thrown instanceof Error) {
    return thrown;
  }

  const error = new Error(
    `Non-Error value thrown (${describeThrownType(thrown)})`
  );
  error.name = NON_ERROR_THROWN_NAME;
  return error;
}

/** `typeof`, except that `null` is reported as itself rather than as an object. */
function describeThrownType(thrown: unknown): string {
  return thrown === null ? "null" : typeof thrown;
}
