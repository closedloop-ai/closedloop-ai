import { prettyDOM } from "@testing-library/react";

/**
 * ISS-10750 / ISS-6732: testing-library's default `getElementError` serializes
 * the WHOLE container with `prettyDOM` every time a query misses — and
 * `waitFor` re-runs the query on every DOM mutation plus every 50ms, then
 * throws the result away until the last attempt. Against the mounted shell
 * that is ~100ms of pretty-format per poll, on the same thread as the lazy
 * route mount the poll is waiting for, so the wait starves the thing it waits
 * for. Under `--coverage` the session-detail heading in
 * `app-shell-sessions.test.tsx` took 15.7s to arrive that way and 2.2s once
 * the dump was deferred (measured on a 16-core box; the CI runner exhausted
 * the 15s budget). The dump is built only for the error that actually
 * surfaces — when `waitFor` copies its stack and wraps it on timeout, never
 * during a poll that goes on to succeed — so a real miss reads exactly as it
 * did before.
 *
 * Pass it as `configure({ getElementError })`. `setupAppShellSuite` does; a
 * suite that mounts the shell but calls `configure()` itself must too.
 */
export function deferredDomDumpElementError(
  message: string | null,
  container: Element
): Error {
  const error = new Error(message ?? "");
  error.name = "TestingLibraryElementError";
  let rendered: string | undefined;
  Object.defineProperty(error, "message", {
    configurable: true,
    enumerable: false,
    get() {
      rendered ??= [
        message,
        `Ignored nodes: comments, script, style\n${prettyDOM(container)}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      return rendered;
    },
  });
  return error;
}
