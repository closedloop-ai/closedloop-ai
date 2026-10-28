import { ApiError } from "@repo/app/shared/api/api-error";
import { PageNotFound } from "@repo/app/shared/components/page-not-found";
import { RouteErrorFallback } from "@repo/app/shared/components/route-error-fallback";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useRendererExceptionReporter } from "../../renderer-exception-reporter";

/**
 * Keeps a failed document read inside the detail route, the Desktop
 * counterpart of web's `notFound()` plus `(authenticated)/error.tsx`. Without
 * it a 404 or a first-load failure reaches `RootErrorBoundary` and replaces the
 * whole renderer.
 *
 * Callers key it on the document identity so navigating to another document
 * starts clean.
 */
export function DocumentDetailErrorBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const reportException = useRendererExceptionReporter();
  return (
    <DocumentDetailErrorBoundaryInner reportException={reportException}>
      {children}
    </DocumentDetailErrorBoundaryInner>
  );
}

type InnerProps = {
  children: ReactNode;
  reportException?: (error: Error, componentStack?: string) => void;
};

type InnerState = {
  error: Error | null;
};

class DocumentDetailErrorBoundaryInner extends Component<
  InnerProps,
  InnerState
> {
  constructor(props: InnerProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): InnerState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    if (isNotFound(error)) {
      return;
    }
    this.props.reportException?.(error, errorInfo.componentStack ?? undefined);
  }

  handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    if (isNotFound(error)) {
      return <PageNotFound />;
    }
    return <RouteErrorFallback onRetry={this.handleRetry} />;
  }
}

function isNotFound(error: Error): boolean {
  return error instanceof ApiError && error.isNotFound();
}
