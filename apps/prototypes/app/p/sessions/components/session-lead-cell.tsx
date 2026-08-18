"use client";

import type { SessionRow } from "../mock";

/**
 * The Sessions lead cell (PRD-557). The session name truncates on overflow.
 * The favorite star and row actions live in the trailing column; the session
 * id is not repeated here.
 */
export function SessionLeadCell({
  item,
  onOpenDetail,
}: {
  item: SessionRow;
  onOpenDetail: (item: SessionRow) => void;
}) {
  return (
    <button
      className="block w-full min-w-0 text-left"
      onClick={() => onOpenDetail(item)}
      type="button"
    >
      <span className="block truncate font-medium text-foreground text-sm hover:underline">
        {item.name}
      </span>
    </button>
  );
}
