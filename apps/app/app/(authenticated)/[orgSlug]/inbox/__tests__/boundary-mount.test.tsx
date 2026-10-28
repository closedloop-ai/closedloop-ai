// @vitest-environment jsdom

/**
 * ISS-10202: where the Inbox route's `LiveblocksErrorBoundary` is MOUNTED,
 * asserted through the REAL boundary and the REAL host.
 *
 * The sibling `page.test.tsx` renders the boundary as a pass-through, which is
 * right for a suite about the transport gate but means moving or deleting the
 * mount leaves that file green. What is pinned HERE is the height of the mount,
 * in both directions: a Liveblocks body failure degrades in place, and a
 * failure in the host's own non-Liveblocks gate does NOT — it reaches the route
 * so `error.tsx` can recover. The boundary's own catch/degrade semantics are
 * pinned in `packages/collaboration/__tests__/liveblocks-error-boundary.test.tsx`.
 */

import { render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import InboxPage from "../page";

const DEGRADED_TEXT = "inbox degraded";
const ROUTE_FALLBACK = "route boundary";
const BODY_FAILURE = "inbox-body-render-failed";
const GATE_FAILURE = "feature-flag-gate-read-failed";

let bodyThrows = 0;
let gateThrows = 0;
let gateFails = false;

/**
 * The gate fails a BOUNDED number of times, and that bound is what makes this
 * case discriminating. A gate that threw forever would reach the route boundary
 * whatever height the Liveblocks boundary sat at, so the case would pass with
 * the mount back above the gate and prove nothing. Failing 3 times — the budget
 * measured in `collaboration-provider-wrapper.test.tsx`, past what React
 * absorbs on its own — means a boundary ABOVE the gate would catch, re-render,
 * and SUCCEED into the degraded body, which is exactly what this case asserts
 * does not happen.
 */
const GATE_THROW_BUDGET = 3;

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => <header />,
}));

// The host's ONE non-Liveblocks decision. Throwing here is the case thread
// review raised: it has no Liveblocks attribution, so degrading the inbox would
// misdescribe it.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagGate: () => {
    if (gateFails && gateThrows < GATE_THROW_BUDGET) {
      gateThrows += 1;
      throw new Error(GATE_FAILURE);
    }
    return { enabled: false, isReady: true };
  },
}));

// Stands in for the legacy transport body: it fails while Liveblocks reads as
// available and renders a Liveblocks-free body once it does not, which is the
// one shape the boundary's degradation is for.
vi.mock("../inbox-legacy-body", () => ({
  InboxLegacyBody: ({ isAvailable }: { isAvailable: boolean }) => {
    if (isAvailable) {
      bodyThrows += 1;
      throw new Error(BODY_FAILURE);
    }
    return <span>{DEGRADED_TEXT}</span>;
  },
}));

/** Stands in for the route segment's `error.tsx`. */
class RouteBoundary extends Component<
  { children: ReactNode; onCaught: (message: string) => void },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; onCaught: (m: string) => void }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onCaught(error instanceof Error ? error.message : String(error));
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <span>{ROUTE_FALLBACK}</span>;
    }
    return this.props.children;
  }
}

// React recovers a failed CONCURRENT render by re-rendering the whole root
// synchronously and announcing it through the root's `onRecoverableError`,
// separately from any boundary catch. React's default handler is `reportError`,
// which in jsdom becomes a process-level uncaught exception and fails the JOB
// on a green suite (ISS-9661). Reading each announcement off this one root, and
// asserting it below, keeps the throw, the recovery and the catch all intact.
function recoveredCauseMessage(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error ? cause.message : undefined;
}

function renderRoute(onCaught: (message: string) => void): string[] {
  const recoveredCauses: (string | undefined)[] = [];

  render(
    <RouteBoundary onCaught={onCaught}>
      <InboxPage />
    </RouteBoundary>,
    // Scoped to THIS root only, so a genuine uncaught error anywhere else in
    // the project still fails the run.
    {
      onRecoverableError: (error) =>
        recoveredCauses.push(recoveredCauseMessage(error)),
    }
  );

  return recoveredCauses.filter(
    (cause): cause is string => typeof cause === "string"
  );
}

describe("the Inbox host's Liveblocks boundary mount", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    bodyThrows = 0;
    gateThrows = 0;
    gateFails = false;
    consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test("degrades a transport-body failure in place instead of letting it reach error.tsx", () => {
    const escaped: string[] = [];

    const recovered = renderRoute((message) => escaped.push(message));

    // The degraded body renders only while availability reads FALSE, which
    // nothing but a catch by the mounted boundary produces — so this is the
    // assertion that the mount exists, not merely that the page rendered.
    expect(screen.getByText(DEGRADED_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(ROUTE_FALLBACK)).not.toBeInTheDocument();
    expect(escaped).toEqual([]);
    // The body really did throw, so the three assertions above cannot be
    // satisfied by a render in which nothing ever failed.
    expect(bodyThrows).toBeGreaterThan(0);
    // Whether React needs a synchronous retry here is React's call, so this
    // list is legitimately empty on some runs. What it pins is that nothing
    // OTHER than this case's own throw was announced on this root — an
    // unrelated recovery fails here rather than escaping as an unhandled error.
    expect(recovered.filter((cause) => cause !== BODY_FAILURE)).toEqual([]);
  });

  test("lets the host's non-Liveblocks gate failure reach route recovery", () => {
    gateFails = true;
    const escaped: string[] = [];

    const recovered = renderRoute((message) => escaped.push(message));

    expect(escaped).toEqual([GATE_FAILURE]);
    expect(screen.getByText(ROUTE_FALLBACK)).toBeInTheDocument();
    // Same locator the case above asserts PRESENT, so this absence is real:
    // a gate throw must not be dressed up as an unavailable inbox.
    expect(screen.queryByText(DEGRADED_TEXT)).not.toBeInTheDocument();
    // It really threw, AND it still had budget left when the route caught it.
    // The second half is what rules out a pass bought by the fixture running
    // out of throws: a boundary above the gate would have caught, re-rendered
    // into the remaining budget and then succeeded into the degraded body.
    expect(gateThrows).toBeGreaterThan(0);
    expect(gateThrows).toBeLessThan(GATE_THROW_BUDGET);
    expect(recovered.filter((cause) => cause !== GATE_FAILURE)).toEqual([]);
  });
});
