"use client";

import type { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { DetailsField } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import type { ReactNode } from "react";
import type { ReadEntityCustomFieldValues } from "../hooks/use-entity-custom-field-values";
import { useCustomFieldDetailsRows } from "./custom-field-details-rows";

type RowsChildren = (rows: readonly DetailsField[]) => ReactNode;

/**
 * Hands a Details host its custom-field rows (ISS-12302). With no reader
 * (desktop Local mode, or no data source at all) or no entity id, the host
 * gets no rows and the custom-field reads are never mounted, so nothing is
 * requested and a mount without an API port (Storybook) does not throw.
 */
export function CustomFieldDetailsRowsScope({
  children,
  entityId,
  entityType,
  itemLabel,
  readValues,
}: Readonly<{
  children: RowsChildren;
  entityId: string | null | undefined;
  entityType: CustomFieldEntityType;
  itemLabel: string;
  readValues: ReadEntityCustomFieldValues | undefined;
}>) {
  if (!(readValues && entityId)) {
    return <>{children(NO_ROWS)}</>;
  }
  return (
    <CustomFieldDetailsRowsReader
      entityId={entityId}
      entityType={entityType}
      itemLabel={itemLabel}
      readValues={readValues}
    >
      {children}
    </CustomFieldDetailsRowsReader>
  );
}

function CustomFieldDetailsRowsReader({
  children,
  ...input
}: Readonly<{
  children: RowsChildren;
  entityId: string;
  entityType: CustomFieldEntityType;
  itemLabel: string;
  readValues: ReadEntityCustomFieldValues;
}>) {
  return <>{children(useCustomFieldDetailsRows(input))}</>;
}

const NO_ROWS: readonly DetailsField[] = [];
