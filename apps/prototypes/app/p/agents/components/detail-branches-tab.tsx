"use client";

import type { GridTableGroup } from "@repo/design-system/components/ui/grid-table";
import type { ReactNode } from "react";
import type { Branch } from "../detail-data";
import { BranchesTable } from "./branches-table";

// Branches tab: the shared branches table of every branch this component
// contributed to. Filter / View / group state is owned by the detail header.
export const DetailBranchesTab = ({
  branches,
  groups,
  hiddenColumns,
  groupIcon,
}: {
  branches: readonly Branch[];
  groups?: GridTableGroup<Branch>[];
  hiddenColumns?: ReadonlySet<string>;
  groupIcon?: ReactNode;
}) => (
  <BranchesTable
    branches={branches}
    groupIcon={groupIcon}
    groups={groups}
    hiddenColumns={hiddenColumns}
  />
);
