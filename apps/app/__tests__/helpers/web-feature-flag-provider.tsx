import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import type { ComponentType, ReactNode } from "react";
import { posthogFeatureFlagAdapter } from "@/lib/app-core-adapters";

/**
 * Mounts the real web feature-flag adapter, the one `AppCoreAdapterProvider`
 * wires at the root layout, so a component that reads a flag through the port
 * resolves it the way it does in the app: through `useFeatureFlag` from
 * `@repo/analytics/client`, which a suite can still mock to drive each flag
 * state (enabled, disabled, unresolved).
 */
export function WebFeatureFlagProvider({ children }: { children: ReactNode }) {
  return (
    <FeatureFlagAdapterProvider adapter={posthogFeatureFlagAdapter}>
      {children}
    </FeatureFlagAdapterProvider>
  );
}

/**
 * Wraps a suite's own `wrapper` (a query client, a router) inside the web
 * feature-flag adapter, for `render` and `renderHook` calls that already pass one.
 */
export function withWebFeatureFlagProvider(
  Wrapper: ComponentType<{ children: ReactNode }>
) {
  return function WebFeatureFlagWrapper({ children }: { children: ReactNode }) {
    return (
      <WebFeatureFlagProvider>
        <Wrapper>{children}</Wrapper>
      </WebFeatureFlagProvider>
    );
  };
}

/**
 * For a suite that mocks the port module to pin the keys it drives through the
 * port, while it drives the keys a component used to read from the SDK through
 * its `@repo/analytics/client` fixture: `sdkKeys` resolve through the real web
 * adapter (so that fixture still decides them, enabled, disabled or
 * unresolved), and every other key through `portFallback`.
 */
export function enabledThroughWebAdapter(
  sdkKeys: readonly string[],
  portFallback: (key: string) => boolean
): (key: string) => boolean {
  return function useEnabledThroughWebAdapter(key) {
    // Called on every read so the hook order never depends on the key.
    const viaWebAdapter = posthogFeatureFlagAdapter.useFeatureFlagEnabled(key);
    return sdkKeys.includes(key) ? viaWebAdapter : portFallback(key);
  };
}
