import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Component, type ErrorInfo, type ReactNode } from "react";

type RootErrorBoundaryProps = {
  children: ReactNode;
  reportException?: (error: Error, componentStack?: string) => void;
};

type RootErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

/**
 * Top-level error boundary for the desktop renderer.
 *
 * A render throw anywhere below the root would otherwise white-screen the
 * entire desktop app. This boundary catches it, surfaces a minimal fallback,
 * and lets the user reload the window to recover.
 */
export class RootErrorBoundary extends Component<
  RootErrorBoundaryProps,
  RootErrorBoundaryState
> {
  constructor(props: RootErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Desktop renderer error boundary caught an error", error, {
      componentStack: errorInfo.componentStack ?? undefined,
    });
    this.props.reportException?.(error, errorInfo.componentStack ?? undefined);
  }

  handleReset = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center text-foreground">
          <div className="space-y-2">
            <h1 className="font-semibold text-lg">Something went wrong</h1>
            <p className="text-muted-foreground text-sm">
              The app ran into an unexpected error. Reloading usually fixes it.
            </p>
          </div>
          <Button onClick={this.handleReset} type="button">
            Reload
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
