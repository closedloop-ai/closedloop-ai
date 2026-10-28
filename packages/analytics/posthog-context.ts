import type { usePostHog } from "@posthog/next";
import type { BrowserAnalyticsContext } from "./browser-context";

type AnalyticsClient = NonNullable<ReturnType<typeof usePostHog>>;
type BeforeSend = Extract<
  NonNullable<AnalyticsClient["config"]["before_send"]>,
  (event: never) => unknown
>;

const contexts = new WeakMap<
  AnalyticsClient,
  { context: BrowserAnalyticsContext; stamp: BeforeSend }
>();

/**
 * ISS-12555: stamp each event after persistence/caller properties are merged.
 * Config survives reset; nothing is registered in shared cookies or profiles.
 * The provider initializes synchronously with automatic pageviews disabled,
 * so its first child can install this before any descendant capture.
 */
export function installBrowserAnalyticsContext(
  client: AnalyticsClient,
  context: BrowserAnalyticsContext
): void {
  let state = contexts.get(client);
  if (state) {
    state.context = { ...context };
  } else {
    const current: { context: BrowserAnalyticsContext; stamp: BeforeSend } = {
      context: { ...context },
      stamp: ((event) =>
        event
          ? {
              ...event,
              properties: { ...event.properties, ...current.context },
            }
          : event) satisfies BeforeSend,
    };
    state = current;
    contexts.set(client, state);
  }
  const existing = client.config.before_send;
  const chain = existing ? [existing].flat() : [];
  if (!chain.includes(state.stamp)) {
    client.set_config({ before_send: [...chain, state.stamp] });
  }
}
