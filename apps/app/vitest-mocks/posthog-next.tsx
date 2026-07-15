import type { ReactNode } from "react";

type PostHogProviderProps = {
  children: ReactNode;
};

type PostHogMiddlewareOptions = {
  response?: Response;
};

const noopClient = {
  identify: () => {},
  capture: () => undefined,
  reset: () => {},
  startSessionRecording: () => {},
  stopSessionRecording: () => {},
  set_config: () => {},
};

export function PostHogProvider({ children }: PostHogProviderProps) {
  return <>{children}</>;
}

export function PostHogPageView() {
  return null;
}

export function usePostHog() {
  return noopClient;
}

export function useFeatureFlag(flag: string) {
  return {
    key: flag,
    enabled: true,
    variant: undefined,
    payload: undefined,
  };
}

export function postHogMiddleware(options: PostHogMiddlewareOptions = {}) {
  return async () => options.response ?? new Response(null);
}
