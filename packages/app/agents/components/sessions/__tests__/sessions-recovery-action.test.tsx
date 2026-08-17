/**
 * @file sessions-recovery-action.test.tsx
 * @description ISS-4534 (wongk) regression coverage for the shared Sessions
 * error-recovery affordance. A PLAIN primary click clears the host's filters (the
 * honest "reload") and navigates to the clean list root; a MODIFIED / non-primary
 * click (Cmd/Ctrl/Shift/Alt or middle-button — the browser opening the href in a
 * new tab/window) must NOT run the clear side effect, so the scope in the current
 * tab is preserved.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Stub the surface-agnostic navigation Link as a plain anchor so it mounts
// without a NavigationProvider ancestor while preserving click semantics.
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

import { SessionsRecoveryAction } from "../sessions-recovery-action";

const HREF = "/acme/sessions";

describe("SessionsRecoveryAction (ISS-4534)", () => {
  it("renders the honest 'Clear filters and reload' Link to the clean list root", () => {
    render(<SessionsRecoveryAction href={HREF} onClearFilters={vi.fn()} />);

    const link = screen.getByRole("link", {
      name: "Clear filters and reload",
    });
    expect(link).toHaveAttribute("href", HREF);
  });

  it("a plain primary click clears filters (the in-tab reload)", () => {
    const onClearFilters = vi.fn();
    render(
      <SessionsRecoveryAction href={HREF} onClearFilters={onClearFilters} />
    );

    fireEvent.click(
      screen.getByRole("link", { name: "Clear filters and reload" })
    );
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  // wongk: a Cmd/Ctrl-click opens the clean URL in a NEW tab — it must not also
  // wipe the filters in the tab the user meant to keep.
  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["shiftKey", { shiftKey: true }],
    ["altKey", { altKey: true }],
    ["middle button", { button: 1 }],
  ])("a modified/non-primary click (%s) does NOT clear filters — the current tab's scope is preserved", (_label, eventInit) => {
    const onClearFilters = vi.fn();
    render(
      <SessionsRecoveryAction href={HREF} onClearFilters={onClearFilters} />
    );

    fireEvent.click(
      screen.getByRole("link", { name: "Clear filters and reload" }),
      eventInit
    );
    expect(onClearFilters).not.toHaveBeenCalled();
  });
});
