"use client";

import { SessionsList } from "./components/sessions-list";
import type { SessionRow } from "./mock";

/**
 * Prototype-safe Sessions V2 surface: the shared V2 shell, toolbar, menus,
 * table, and pagination come from the design system while mock rows and the
 * detail callback stay local to the isolated prototype app.
 */
export function SessionsV2Surface({
  onOpenDetail,
}: {
  onOpenDetail: (row: SessionRow) => void;
}) {
  return <SessionsList onOpenDetail={onOpenDetail} />;
}
