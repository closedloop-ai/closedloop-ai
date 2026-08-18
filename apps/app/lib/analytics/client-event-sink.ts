/**
 * The browser capture sink, reachable from modules that are not React.
 *
 * `useAnalytics()` is a hook, so a plain fetch/parse module — a TanStack query
 * function, a schema boundary — cannot reach PostHog at all. Client code is also
 * barred from logging (`scripts/lint/rules/no-client-debug-logging.ts`): a
 * `console.*` lands in the end user's devtools and never reaches an aggregator,
 * so analytics IS the client monitoring path. This carries the app's existing
 * sink across that gap instead of adding a second reporting mechanism.
 *
 * Registered once by `AppSurfaceAnalyticsProvider` at the root layout. Before
 * that runs — and in tests and Storybook, which mount no provider — capture is a
 * no-op rather than an error: losing an observability event must never break a
 * render.
 */

/** Primitive values an event property may hold. No PII, no objects. */
export type ClientEventPropertyValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | string[];

export type ClientEventProperties = Record<string, ClientEventPropertyValue>;

export type ClientEventSink = (
  event: string,
  properties: ClientEventProperties
) => void;

let clientEventSink: ClientEventSink | undefined;

/**
 * Install (or, with `undefined`, uninstall) the sink. Called by the root
 * analytics adapter; a test that asserts on capture installs its own and clears
 * it in teardown.
 */
export function setClientEventSink(sink: ClientEventSink | undefined): void {
  clientEventSink = sink;
}

/** Emit through the installed sink, or drop the event when none is installed. */
export function captureClientEvent(
  event: string,
  properties: ClientEventProperties
): void {
  clientEventSink?.(event, properties);
}
