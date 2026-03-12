"use client";

import Link from "next/link";
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
  return (
    <Link
      className={className ?? "hover:underline"}
      href={`/users/${userId}`}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
      }}
    >
      {children}
    </Link>
  );
}
