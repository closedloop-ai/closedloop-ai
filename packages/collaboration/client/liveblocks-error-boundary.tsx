"use client";

import { log } from "@repo/observability/log";
import {
  Component,
  type ContextType,
  createContext,
  type ErrorInfo,
  type ReactNode,
  useContext,
} from "react";

type ErrorBoundaryState = {
  hasError: boolean;
  error: unknown;
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

const AVAILABLE: LiveblocksAvailability = { isAvailable: true };
const UNAVAILABLE: LiveblocksAvailability = { isAvailable: false };

function isSecurityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return SECURITY_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Error boundary for Liveblocks inbox features.
 * Provides an `isAvailable` context flag that inbox components check before calling hooks.
 * Security errors (403/401) are logged as errors; transient errors as warnings.
 *
 * MOUNT IT AROUND A LIVEBLOCKS-DEPENDENT SUBTREE ONLY, never around the
 * authenticated shell (ISS-10202): degrading means re-rendering the children it
 * caught, which for anything but a component that reads `isAvailable` and has a
 * Liveblocks-free branch is a swallowed failure the route's `error.tsx` never
 * sees.
 */
export class LiveblocksErrorBoundary extends Component<
  LiveblocksErrorBoundaryProps,
  ErrorBoundaryState
> {
  // Composed rather than overridden, so a boundary nested under the bootstrap
  // window's `isAvailable: false` cannot re-open the hooks that window gates.
  static contextType = LiveblocksAvailabilityContext;
  declare context: ContextType<typeof LiveblocksAvailabilityContext>;

  constructor(props: LiveblocksErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, error };
  }

  /**
   * Only ever reached on the DEGRADE path, so there is no escalation log here
   * and adding one would be dead code. React queues this callback on the error
   * update and runs it when that update COMMITS; on the escalation path the
   * re-render throws again out of `render()`, the update is discarded, and this
   * never runs. Measured on react-dom 19.2.8 and pinned by the "escalates a
   * caught value that is not an Error" case, which asserts neither log fires.
   * The escalated value is reported by the boundary above instead.
   */
  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    const details = {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
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
    if (this.shouldEscalate()) {
      throw this.state.error;
    }

    return (
      <LiveblocksAvailabilityContext.Provider value={this.availability()}>
        {this.props.children}
      </LiveblocksAvailabilityContext.Provider>
    );
  }

  // A value React does not promise is an `Error` is not a failure this boundary
  // can attribute to Liveblocks, and degrading the inbox would not describe it.
  // Before ISS-10202 such a value escaped only because `isSecurityError` threw
  // on `.message`; escalating it here is that same outcome, deliberately.
  private shouldEscalate(): boolean {
    return this.state.hasError && !(this.state.error instanceof Error);
  }

  private availability(): LiveblocksAvailability {
    const isAvailable = this.context.isAvailable && !this.state.hasError;
    return isAvailable ? AVAILABLE : UNAVAILABLE;
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
