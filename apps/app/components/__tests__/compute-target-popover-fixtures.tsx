import type React from "react";

/**
 * Shared scaffolding for the two ComputeTargetPopover suites — target
 * selection (`compute-target-popover.test.tsx`) and the ISS-6109 launch
 * fallback (`compute-target-launch-fallback.test.tsx`).
 *
 * The stubs below stand in for Radix primitives that never render their
 * children in jsdom without a real trigger. Both suites drive the same popover,
 * so they must see the same stand-ins; a second copy is how the two files start
 * asserting against different DOM.
 */

export const onlineTarget = {
  id: "ct-local",
  machineName: "my-mac",
  platform: "macOS",
  isOnline: true,
  organizationId: "org-1",
  userId: "user-1",
  capabilities: {},
  supportedOperations: [],
  lastSeenAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

export const offlineTarget = {
  ...onlineTarget,
  id: "ct-offline",
  isOnline: false,
};

/** A teammate's machine: `ownerName` is what splits shared from own targets. */
export const sharedOnlineTarget = {
  ...onlineTarget,
  id: "ct-shared",
  machineName: "team-mac",
  ownerName: "Teammate",
  isOnline: true,
};

export const defaultSidebar = { open: true };

export function SidebarMenuButtonStub({
  children,
  "aria-label": ariaLabel,
  tooltip,
}: {
  children: React.ReactNode;
  "aria-label"?: string;
  tooltip?: string;
}) {
  return (
    <button
      aria-label={ariaLabel}
      data-testid="sidebar-menu-button"
      title={tooltip}
      type="button"
    >
      {children}
    </button>
  );
}

export function PopoverStub({
  children,
  open,
}: {
  children: React.ReactNode;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  return (
    <div data-open={open} data-testid="popover">
      {children}
    </div>
  );
}

export function PopoverTriggerStub({
  children,
}: {
  children: React.ReactNode;
  asChild?: boolean;
}) {
  return <div data-testid="popover-trigger">{children}</div>;
}

export function PopoverContentStub({
  children,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  "aria-label"?: string;
}) {
  return (
    <section aria-label={ariaLabel} data-testid="popover-content">
      {children}
    </section>
  );
}
