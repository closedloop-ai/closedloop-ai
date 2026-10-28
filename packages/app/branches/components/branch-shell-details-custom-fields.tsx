"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { CustomFieldDetailsRowsScope } from "@repo/app/custom-fields/components/custom-field-details-rows-scope";
import type { DetailsField } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import type { ReactNode } from "react";
import { useBranchesDataSourceOptional } from "../data-source/provider";

/**
 * The Branch Details tab's custom-field rows (ISS-12302), keyed by the
 * branch's `artifactId` and read through the active source's optional
 * `customFieldValues`. A branch with no artifact, and desktop Local mode's
 * source, which has no reader, draw no Custom fields section and read nothing.
 */
export function BranchShellCustomFieldRows({
  children,
  detail,
}: Readonly<{
  children: (rows: readonly DetailsField[]) => ReactNode;
  detail: BranchPageDetail;
}>) {
  const source = useBranchesDataSourceOptional();
  return (
    <CustomFieldDetailsRowsScope
      entityId={detail.artifactId}
      entityType={CustomFieldEntityType.Branch}
      itemLabel={detail.branchName}
      readValues={source?.customFieldValues}
    >
      {children}
    </CustomFieldDetailsRowsScope>
  );
}
