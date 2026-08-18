"use client";

import type { GridTableGroup } from "@repo/design-system/components/ui/grid-table";
import type { ReactNode } from "react";
import type { MockSession } from "../mock";
import { SessionsTable } from "./sessions-table";

// Sessions tab: the shared sessions table of every session this component was
// seen in. Filter / View / group state is owned by the detail header.
export const DetailSessionsTab = ({
  sessions,
  groups,
  hiddenColumns,
  groupIcon,
}: {
  sessions: readonly MockSession[];
  groups?: GridTableGroup<MockSession>[];
  hiddenColumns?: ReadonlySet<string>;
  groupIcon?: ReactNode;
}) => (
  <SessionsTable
    groupIcon={groupIcon}
    groups={groups}
    hiddenColumns={hiddenColumns}
    sessions={sessions}
  />
);
