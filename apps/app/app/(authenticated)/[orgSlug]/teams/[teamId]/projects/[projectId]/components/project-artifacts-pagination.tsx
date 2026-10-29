"use client";

import { TablePaginationFooter } from "@repo/design-system/components/ui/table-pagination-footer";
import type { ComponentProps } from "react";

export function ProjectArtifactsPagination({
  footerProps,
  layout,
  show,
}: Readonly<{
  footerProps: ComponentProps<typeof TablePaginationFooter>;
  layout: "board" | "list";
  show: boolean;
}>) {
  if (!(layout === "list" && show)) {
    return null;
  }
  return <TablePaginationFooter {...footerProps} />;
}
