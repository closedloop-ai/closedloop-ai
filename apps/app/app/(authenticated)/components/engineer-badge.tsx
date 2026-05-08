"use client";

import { useUnreadSessionCount } from "@/hooks/engineer/use-active-session-count";
import { SidebarCountBadge } from "./sidebar-count-badge";

export function EngineerBadge() {
  const count = useUnreadSessionCount();

  if (count === 0) {
    return null;
  }

  return <SidebarCountBadge count={count} />;
}
