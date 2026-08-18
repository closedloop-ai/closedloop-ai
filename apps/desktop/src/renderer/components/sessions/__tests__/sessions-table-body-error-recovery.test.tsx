/**
 * @file sessions-table-body-error-recovery.test.tsx
 * @description ISS-4534 regression coverage for the desktop Sessions failure
 * states. The SETTLED-error honest-empty card must not be a dead end: it carries
 * a single honest "Clear filters and reload" recovery affordance (a superset of a
 * bare retry), not a Retry-plus-nav pair. The HARD-STALL "temporarily
 * unavailable" state is a wedged-but-not-errored load, so it carries only Retry
 * and must NOT offer the scope-discarding recovery link. Renders the real
 * {@link SessionsTableBody} → shared `AgentSessionsListContent` →
 * `SessionsEmptyState` path, stubbing only the navigation `Link` as a plain
 * anchor so no NavigationProvider is needed.
 */
import type { ListEmptyStateSignals } from "@repo/api/src/list-empty-state";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Render the surface-agnostic navigation Link as a plain anchor so we can assert
// the href without mounting a NavigationProvider adapter (mirrors the
// help-on-this-button test).
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { Link } from "@repo/navigation/link";
import { SessionsTableBody } from "../sessions-table-body";

const ERRORED_SIGNALS: ListEmptyStateSignals = {
  isUnavailable: true,
  hasActiveFilters: false,
};

const RECOVERY_LINK = <Link href="/sessions">Clear filters and reload</Link>;

function renderErroredBody(
  overrides: {
    onRetry?: () => void;
    stallPhase?: "none" | "soft" | "hard";
    errorRecoveryAction?: ReactNode;
  } = {}
) {
  const onRetry = overrides.onRetry ?? vi.fn();
  const errorRecoveryAction = overrides.errorRecoveryAction ?? RECOVERY_LINK;
  render(
    <SessionsTableBody
      emptySignals={ERRORED_SIGNALS}
      errorRecoveryAction={errorRecoveryAction}
      hasData={false}
      isLoading={false}
      onClearFilters={vi.fn()}
      onRetry={onRetry}
      onSort={vi.fn()}
      sessions={[]}
      sortBy={null}
      sortDir="desc"
      stallPhase={overrides.stallPhase ?? "none"}
      visibleColumns={new Set<string>(["name"])}
    />
  );
  return { onRetry };
}

describe("SessionsTableBody error recovery (ISS-4534)", () => {
  it("settled-error card renders the single 'Clear filters and reload' recovery link, replacing the standalone Retry", () => {
    renderErroredBody();

    expect(screen.getByText("Couldn't load sessions")).not.toBeNull();
    // The recovery affordance is the honest superset action...
    const recovery = screen.getByRole("link", {
      name: "Clear filters and reload",
    });
    expect(recovery.getAttribute("href")).toBe("/sessions");
    // ...and it REPLACES the redundant standalone Retry (which only re-ran the
    // same failing read the recovery already reloads).
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("hard-stall 'temporarily unavailable' state offers Retry and NOT the scope-discarding recovery link", () => {
    // A blocking load stalled past the hard threshold: loading + no rows + hard.
    const onRetry = vi.fn();
    render(
      <SessionsTableBody
        emptySignals={ERRORED_SIGNALS}
        errorRecoveryAction={RECOVERY_LINK}
        hasData={false}
        isLoading
        onClearFilters={vi.fn()}
        onRetry={onRetry}
        onSort={vi.fn()}
        sessions={[]}
        sortBy={null}
        sortDir="desc"
        stallPhase="hard"
        visibleColumns={new Set<string>(["name"])}
      />
    );

    expect(
      screen.getByText("Sessions are temporarily unavailable")
    ).not.toBeNull();
    // Retry re-arms the stall detector — the honest recovery for a wedged load.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // The stall is NOT a settled error, so the "Clear filters and reload"
    // recovery (which would discard filters the user picked) must not appear.
    expect(
      screen.queryByRole("link", { name: "Clear filters and reload" })
    ).toBeNull();
  });
});
