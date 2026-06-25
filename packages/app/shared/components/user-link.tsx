"use client";

import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import type { MouseEvent, ReactNode } from "react";

type UserLinkProps = {
  userId: string;
  children: ReactNode;
  className?: string;
};

/**
 * Wraps children in a Next.js Link to the user's profile page.
 * Stops propagation on click to avoid triggering parent row handlers.
 */
export function UserLink({ userId, children, className }: UserLinkProps) {
  const buildOrgPath = useOrgPath();
  return (
    <Link
      className={className ?? "hover:underline"}
      href={buildOrgPath(`/users/${userId}`)}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
      }}
    >
      {children}
    </Link>
  );
}
