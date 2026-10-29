"use client";

import {
  type NavigationDestinationCount,
  pendingNavigationCount,
  toNavigationCount,
  unavailableNavigationCount,
} from "@repo/api/src/types/navigation-view-model";
import { ShellSidebar } from "@repo/app/shell/v2/components/shell-sidebar";
import { useUnreadInboxCount } from "@repo/collaboration/client/inbox-count";
import { useLiveblocksAvailability } from "@repo/collaboration/client/liveblocks-error-boundary";
import { useEffect, useState } from "react";
import { WorkspaceHeader } from "../workspace-header";
import { useWebShellNavigation } from "./use-web-shell-navigation";

/**
 * Prefix for the v2 sections' persisted open state (PLN-2016 D9).
 *
 * A key nobody has written, deliberately: the legacy Labs preference is about a
 * DIFFERENT section, and reading it here would let a user who once collapsed
 * five optional extras hydrate the v2 tree collapsed. Rollback therefore
 * restores each user's real legacy preference, because the off arm never reads
 * or writes anything under this prefix.
 */
const SHELL_V2_SECTION_PERSISTENCE_KEY_PREFIX = "closedloop.shell.v2.sidebar";

type WebShellSidebarProps = {
  readonly envBadge: string | null;
};

/**
 * The web mount of the shared v2 sidebar (ISS-9734, PLN-2016 M2).
 *
 * Renders `ShellSidebar` — which brings its own sidebar ROOT — so this component
 * replaces the host's `<Sidebar>` rather than rendering inside it. Nesting one
 * sidebar root in another also nests a Sheet in a Sheet below the `md`
 * breakpoint, which is why the branch above it is at the root and not deeper.
 *
 * The workspace menu is passed as the inner `WorkspaceHeader` node: the
 * composite applies the header wrapping itself, so the menu is mounted once,
 * here, and not a second time by the legacy chrome.
 */
export function WebShellSidebar({ envBadge }: WebShellSidebarProps) {
  const { isAvailable } = useLiveblocksAvailability();
  const [readCount, setReadCount] = useState(pendingNavigationCount);

  // A branch, not a boolean handed down, because a hook is what opens the
  // subscription and only an unmounted component does not call one.
  // Availability is false through the whole `CollaborationProviderWrapper`
  // bootstrap window, whose own comment says inbox hooks are held off by
  // exactly this. The branch is a leaf BESIDE the sidebar: two sidebar types at
  // this position remounted the whole `ShellSidebar` when availability flipped
  // (tamsinb, PR #7741).
  return (
    <>
      {isAvailable ? <UnreadInboxCountReader onRead={setReadCount} /> : null}
      <WebShellSidebarView
        envBadge={envBadge}
        inboxCount={isAvailable ? readCount : unavailableNavigationCount()}
      />
    </>
  );
}

/** The one component that subscribes to the unread-inbox count. */
function UnreadInboxCountReader({
  onRead,
}: {
  readonly onRead: (count: NavigationDestinationCount) => void;
}) {
  const result = useUnreadInboxCount();

  useEffect(() => {
    onRead(inboxCount(result));
    return () => onRead(pendingNavigationCount());
  }, [result, onRead]);

  return null;
}

function WebShellSidebarView({
  envBadge,
  inboxCount: count,
}: WebShellSidebarProps & { readonly inboxCount: NavigationDestinationCount }) {
  const { activePath, footer, renderControl, renderIcon, sections } =
    useWebShellNavigation({ envBadge, inboxCount: count });

  return (
    <ShellSidebar
      activePath={activePath}
      footer={footer}
      renderControl={renderControl}
      renderIcon={renderIcon}
      sectionPersistenceKeyPrefix={SHELL_V2_SECTION_PERSISTENCE_KEY_PREFIX}
      sections={sections}
      workspaceHeader={<WorkspaceHeader />}
    />
  );
}

/**
 * The Liveblocks read as a count the fold can render. A still-loading or failed
 * read stays PENDING or UNAVAILABLE rather than folding to a settled zero, which
 * would announce "nothing unread" for a read that never landed.
 */
function inboxCount(
  result: ReturnType<typeof useUnreadInboxCount>
): NavigationDestinationCount {
  if (result.isLoading) {
    return pendingNavigationCount();
  }
  if ("error" in result && result.error !== undefined) {
    return unavailableNavigationCount();
  }
  if ("count" in result) {
    return toNavigationCount(result.count);
  }
  return unavailableNavigationCount();
}
