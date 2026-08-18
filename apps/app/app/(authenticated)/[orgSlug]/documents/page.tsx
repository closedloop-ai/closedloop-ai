import type { Metadata } from "next";
import { Header } from "../../components/header";
import { DocumentsCreateAction } from "./components/documents-create-action";
import { DocumentsIndexView } from "./components/documents-index-view";

export const metadata: Metadata = {
  title: "Documents",
  description: "Org-level documents not attached to a project",
};

/**
 * Org-level Documents index (FEA-4140). Lists the org's project-less DOC
 * artifacts (evergreen documents) via the shared document table. The dynamic
 * `documents/[slug]` route is a separate catch-all that resolves artifact slugs
 * (e.g. Liveblocks inbox notification URLs) to their type-specific detail
 * routes and is unaffected by this index.
 */
export default function DocumentsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "Documents" }]}>
        <DocumentsCreateAction />
      </Header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <DocumentsIndexView />
      </div>
    </div>
  );
}
