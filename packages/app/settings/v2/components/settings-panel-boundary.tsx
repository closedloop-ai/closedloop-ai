"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TriangleAlertIcon } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The wait while a lazily-registered panel body downloads. A skeleton rather
 * than an empty region, so "still arriving" cannot be read as "nothing here".
 */
export function SettingsPanelLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="flex flex-col gap-4"
      data-settings-panel-state="loading"
      role="status"
    >
      <span className="sr-only">Loading settings panel</span>
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

type SettingsPanelErrorBoundaryProps = {
  children: ReactNode;
  reportException?: (error: Error, componentStack?: string) => void;
};

type SettingsPanelErrorBoundaryState = {
  error: Error | null;
};

/**
 * Contains a panel body's render throw to the panel. Without it a lazy chunk
 * that fails to load takes the whole Settings surface down with it, which is
 * exactly the blanking ISS-8362 AC1 forbids: the navigation stays mounted and
 * the user can move to a panel that works.
 *
 * Callers MUST key this on the active panel id. React state survives a prop
 * change, so without a `key` a crashed panel's error screen would still be on
 * screen after the user navigates to a working one.
 */
export class SettingsPanelErrorBoundary extends Component<
  SettingsPanelErrorBoundaryProps,
  SettingsPanelErrorBoundaryState
> {
  constructor(props: SettingsPanelErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(
    error: Error
  ): SettingsPanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.reportException?.(error, errorInfo.componentStack ?? undefined);
  }

  render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    // No "Try again" here, deliberately. The failure this boundary is built for
    // is a rejected lazy chunk, and React caches that rejection on the lazy
    // component itself: `lazyInitializer` moves the payload to `_status = 2` and
    // every later read re-throws `_result` without calling the loader again. So
    // an action that only cleared `error` would re-render the same lazy, land
    // straight back on this screen, and be a control that cannot do what it
    // says. Recovery is the navigation, which stays mounted beside this (AC1);
    // a genuine in-place retry needs the descriptor to expose its module loader
    // so a FRESH `lazy()` can be built, which is a contract change this PR does
    // not make.
    return (
      <div data-settings-panel-state="render-error" role="alert">
        <EmptyState
          description="Nothing was changed. Pick another settings panel, or reload the page to try this one again."
          icon={TriangleAlertIcon}
          title="This panel failed to load"
          titleAs="h2"
        />
      </div>
    );
  }
}
