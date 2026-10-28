import { documentsGroupingState } from "@repo/app/documents/lib/documents-group-link";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  type TableCollapsedGroups,
  tableGroupingAxisKey,
} from "@repo/app/shared/lib/table-collapsed-groups";
import { type ComponentProps, useState } from "react";
import { DocumentsView } from "./documents-view";

/** The board's linked collapse, held in story state so the band still toggles. */
export function ClosedBandDocumentsView({
  initialCollapsedGroups,
  ...props
}: ComponentProps<typeof DocumentsView> & {
  initialCollapsedGroups: TableCollapsedGroups;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState(
    initialCollapsedGroups
  );
  return (
    <DocumentsView
      {...props}
      collapsedGroups={collapsedGroups}
      onCollapsedGroupsChange={setCollapsedGroups}
    />
  );
}

/** The persisted collapse shape used by the closed-band story fixture. */
export function closedBandGroups(bandKey: string): TableCollapsedGroups {
  const axis = tableGroupingAxisKey(documentsGroupingState(GroupByMode.Status));
  return axis === null ? {} : { [axis]: [bandKey] };
}
