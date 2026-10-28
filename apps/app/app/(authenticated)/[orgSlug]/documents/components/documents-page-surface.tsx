"use client";

import { DocumentsIndexSurface } from "@repo/app/documents/components/index/documents-index-surface";
import { Header } from "../../../components/header";

export function DocumentsPageSurface() {
  return (
    <DocumentsIndexSurface
      renderHeader={(action) => (
        <Header breadcrumbs={[{ label: "Documents" }]}>{action}</Header>
      )}
    />
  );
}
