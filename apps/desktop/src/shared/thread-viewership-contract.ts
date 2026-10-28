/**
 * @file thread-viewership-contract.ts
 * @description ISS-7830 — the renderer→main channel that records a user having
 * navigated INTO one thread.
 *
 * The renderer is the only process that knows a person opened a thread, and the
 * main process is the only one that can persist it, so the fact has to cross this
 * boundary. Zod-free for the reason its `dead-end-telemetry-contract.ts` sibling
 * is: the payload is one session id, which the handler re-validates behind the
 * boundary with the same `coerceDbId` every other session-keyed channel uses.
 */

/** Renderer→main channel recording one thread view. */
export const THREAD_VIEWED_CHANNEL = "desktop:db:mark-session-viewed";

/**
 * What the handler answers.
 *
 * `recorded` is whether a view is now on record for that session — NOT that the
 * channel was reached. A flat `true` over a rejected id is the confident value
 * that makes a dropped signal look delivered, and a dropped capture is this
 * feature's entire failure mode.
 */
export type ThreadViewedResult = {
  recorded: boolean;
};
