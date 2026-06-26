"use client";

import { log } from "@repo/observability/log";
import {
  Component,
  createContext,
  type ErrorInfo,
  type ReactNode,
  useContext,
} from "react";

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

type LiveblocksAvailability = {
  isAvailable: boolean;
};

export const LiveblocksAvailabilityContext =
  createContext<LiveblocksAvailability>({
    isAvailable: true,
  });

type LiveblocksErrorBoundaryProps = {
  children: ReactNode;
};

const SECURITY_ERROR_PATTERNS = ["403", "forbidden", "unauthorized", "401"];

function isSecurityError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return SECURITY_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Error boundary for Liveblocks inbox features.
 * Provides an `isAvailable` context flag that inbox components check before calling hooks.
 * Security errors (403/401) are logged as errors; transient errors as warnings.
 */
export class LiveblocksErrorBoundary extends Component<
  LiveblocksErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: LiveblocksErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const details = {
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    };

    if (isSecurityError(error)) {
      log.error(
        "[LiveblocksErrorBoundary] Security error - inbox unavailable",
        details
      );
    } else {
      log.warn(
        "[LiveblocksErrorBoundary] Liveblocks error - inbox degraded",
        details
      );
    }
  }

  render(): ReactNode {
    return (
      <LiveblocksAvailabilityContext.Provider
        value={{ isAvailable: !this.state.hasError }}
      >
        {this.props.children}
      </LiveblocksAvailabilityContext.Provider>
    );
  }
}

/**
 * Hook to check if Liveblocks inbox features are available.
 * Returns false after an error boundary catch, signaling components
 * should not call Liveblocks hooks.
 */
export function useLiveblocksAvailability(): LiveblocksAvailability {
  return useContext(LiveblocksAvailabilityContext);
}
