"use client";

import { DocumentHostProvider } from "@repo/app/documents/components/document-host-context";
import type { VersionedDocumentEditorProps } from "@repo/app/documents/components/versioned-document-editor-container";
import { DocumentDetailEditor } from "@repo/app/documents/editors/document-detail-editor";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import { notFound } from "next/navigation";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { MobileSearchOverlay } from "../../../components/mobile-search-overlay";

export function DocumentEditor(props: Readonly<VersionedDocumentEditorProps>) {
  const orgSlug = useOrgSlug();
  return (
    <DocumentHostProvider
      mobileSearch={<MobileSearchOverlay />}
      orgSlug={orgSlug}
      sidebarTrigger={<SidebarTrigger className="-ml-1 shrink-0" />}
    >
      <DocumentDetailEditor {...props} onNotFound={notFound} />
    </DocumentHostProvider>
  );
}
