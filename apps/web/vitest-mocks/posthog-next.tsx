import type { ReactNode } from "react";

/**
 * `@posthog/next` ships no resolvable ESM subpath outside a bundler, so any
 * suite whose module graph reaches it dies on `Cannot find module
 * .../dist/client/PostHogPageView` before a single assertion runs. FEA-3570 put
 * it on that graph for the first time: the gated GitHub logo reads a flag
 * through `@repo/analytics/client`, and the header, footer, hero, and site-links
 * record all reach the logo.
 *
 * Mirrors `apps/app/vitest-mocks/posthog-next.tsx`, with one deliberate
 * difference: the flag reads DISABLED here. Closed is the shipped default for a
 * UI flag, so it is the honest baseline for a suite asserting what the marketing
 * site renders today; a mock that answered `true` would quietly assert the
 * rolled-out state instead. A suite testing an open flag mocks
 * `@repo/analytics/client` itself, above this.
 */
export function PostHogProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function PostHogPageView() {
  return null;
}

export function usePostHog() {
  return {
    identify: () => {},
    capture: () => undefined,
    reset: () => {},
    startSessionRecording: () => {},
    stopSessionRecording: () => {},
    set_config: () => {},
  };
}

export function useFeatureFlag(flag: string) {
  return { key: flag, enabled: false, variant: undefined, payload: undefined };
}
