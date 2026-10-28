// @vitest-environment jsdom

/**
 * ISS-10202: this boundary used to wrap the whole authenticated shell, so a
 * render failure anywhere under it was absorbed here and the route's
 * `error.tsx` never saw it. The fix is where it is MOUNTED — pinned at the
 * wiring by `collaboration-provider-wrapper.test.tsx`. These cases pin what it
 * still owns once scoped: the degradation itself, and an availability that
 * composes with its ancestor rather than overriding it.
 */

import {
  LiveblocksAvailabilityContext,
  LiveblocksErrorBoundary,
  useLiveblocksAvailability,
} from "@repo/collaboration/client/liveblocks-error-boundary";
import { log } from "@repo/observability/log";
import { render, screen } from "@testing-library/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn() },
}));

const DEGRADED_TEXT = "degraded";
const HEALTHY_TEXT = "healthy";
const OUTER_FALLBACK = "outer boundary";
const LIVEBLOCKS_FAILURE = "liveblocks-read-failed";
const NON_ERROR_THROW = "liveblocks-threw-a-string";
// Upper-case on purpose: the match lowercases the message first.
const SECURITY_FAILURE = "Room auth FORBIDDEN";

/**
 * Stands in for an inbox surface: it throws while Liveblocks is reported
 * available and renders a Liveblocks-free body once it is not — which is the
 * only shape for which re-rendering the caught children is a real degradation.
 */
function InboxLikeSurface() {
  const { isAvailable } = useLiveblocksAvailability();

  if (!isAvailable) {
    return <span>{DEGRADED_TEXT}</span>;
  }
  throw new Error(LIVEBLOCKS_FAILURE);
}

/**
 * Throws a value React does not promise is an `Error`, a bounded number of
 * times, and then renders.
 *
 * The recovery is what makes the case discriminating: React absorbs a throw or
 * two of its own accord and escalates a subtree that keeps failing, so a
 * surface that throws forever reaches the boundary above whether or not this
 * boundary escalates. The budget is the 3 measured in
 * `packages/app/documents/components/__tests__/collaboration-provider-wrapper.test.tsx`
 * — past React's own absorption, but few enough that a boundary which DEGRADES
 * on this value really does end up rendering the body.
 */
const NON_ERROR_THROW_BUDGET = 3;
let nonErrorThrows = 0;

function NonErrorThrowingSurface(): ReactNode {
  if (nonErrorThrows < NON_ERROR_THROW_BUDGET) {
    nonErrorThrows += 1;
    throw NON_ERROR_THROW;
  }
  return <span>{DEGRADED_TEXT}</span>;
}

function AvailabilityProbe() {
  const { isAvailable } = useLiveblocksAvailability();
  return <span data-testid="availability">{String(isAvailable)}</span>;
}

type OuterBoundaryState = { caught: unknown; hasError: boolean };

/**
 * Stands in for the route's `error.tsx`. Records what reached it so a case can
 * assert the identity of the escalated value, not merely that something did.
 */
class OuterBoundary extends Component<
  { children: ReactNode; onCaught: (value: unknown) => void },
  OuterBoundaryState
> {
  constructor(props: { children: ReactNode; onCaught: (v: unknown) => void }) {
    super(props);
    this.state = { caught: null, hasError: false };
  }

  static getDerivedStateFromError(error: unknown): OuterBoundaryState {
    return { caught: error, hasError: true };
  }

  componentDidCatch(error: unknown, _errorInfo: ErrorInfo): void {
    this.props.onCaught(error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <span>{OUTER_FALLBACK}</span>;
    }
    return this.props.children;
  }
}

describe("LiveblocksErrorBoundary", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nonErrorThrows = 0;
    vi.mocked(log.error).mockClear();
    vi.mocked(log.warn).mockClear();
    // React prints every caught render error; silence it so a passing run is
    // not noisy. Scoped to these cases by the restore below.
    consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test("degrades a Liveblocks surface in place instead of escalating", () => {
    const caught: unknown[] = [];

    render(
      <OuterBoundary onCaught={(value) => caught.push(value)}>
        <LiveblocksErrorBoundary>
          <InboxLikeSurface />
          <AvailabilityProbe />
        </LiveblocksErrorBoundary>
      </OuterBoundary>
    );

    expect(screen.getByText(DEGRADED_TEXT)).toBeInTheDocument();
    expect(screen.getByTestId("availability")).toHaveTextContent("false");
    expect(screen.queryByText(OUTER_FALLBACK)).not.toBeInTheDocument();
    expect(caught).toEqual([]);
    // Degrading is the path `componentDidCatch` actually commits on, so the
    // warning lands. This is the PRESENCE half that makes the absence asserted
    // in the escalation case below mean something rather than pass vacuously
    // on a broken logger mock.
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[LiveblocksErrorBoundary] Liveblocks error - inbox degraded",
      expect.objectContaining({ error: LIVEBLOCKS_FAILURE })
    );
  });

  test("logs a security failure as an error and still degrades", () => {
    function SecurityFailingSurface() {
      const { isAvailable } = useLiveblocksAvailability();
      if (!isAvailable) {
        return <span>{DEGRADED_TEXT}</span>;
      }
      throw new Error(SECURITY_FAILURE);
    }

    render(
      <LiveblocksErrorBoundary>
        <SecurityFailingSurface />
      </LiveblocksErrorBoundary>
    );

    expect(screen.getByText(DEGRADED_TEXT)).toBeInTheDocument();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      "[LiveblocksErrorBoundary] Security error - inbox unavailable",
      expect.objectContaining({ error: SECURITY_FAILURE })
    );
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  test("escalates a caught value that is not an Error instead of degrading", () => {
    const caught: unknown[] = [];

    render(
      <OuterBoundary onCaught={(value) => caught.push(value)}>
        <LiveblocksErrorBoundary>
          <NonErrorThrowingSurface />
        </LiveblocksErrorBoundary>
      </OuterBoundary>
    );

    expect(screen.getByText(OUTER_FALLBACK)).toBeInTheDocument();
    // Not the degraded body: this value is not one the boundary can attribute
    // to Liveblocks, so degrading the inbox would not describe it.
    expect(screen.queryByText(DEGRADED_TEXT)).not.toBeInTheDocument();
    expect(caught).toEqual([NON_ERROR_THROW]);
    expect(nonErrorThrows).toBe(NON_ERROR_THROW_BUDGET);
    // NOTHING is logged here, and that is a property of React rather than a
    // choice: the error update carrying `componentDidCatch` is discarded when
    // the re-render throws back out of `render()`. This is why the boundary
    // carries no escalation log — one would be unreachable. The boundary above
    // owns reporting the value, and `caught` above proves it received it.
    expect(vi.mocked(log.error)).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  test("cannot report available inside an ancestor that reports unavailable", () => {
    render(
      <LiveblocksAvailabilityContext.Provider value={{ isAvailable: false }}>
        <LiveblocksErrorBoundary>
          <AvailabilityProbe />
        </LiveblocksErrorBoundary>
      </LiveblocksAvailabilityContext.Provider>
    );

    expect(screen.getByTestId("availability")).toHaveTextContent("false");
  });

  test("reports available with no error and no gating ancestor", () => {
    render(
      <LiveblocksErrorBoundary>
        <span>{HEALTHY_TEXT}</span>
        <AvailabilityProbe />
      </LiveblocksErrorBoundary>
    );

    expect(screen.getByText(HEALTHY_TEXT)).toBeInTheDocument();
    expect(screen.getByTestId("availability")).toHaveTextContent("true");
  });
});
