import type { Metadata } from "next";
import { DocumentsPageSurface } from "./components/documents-page-surface";

export const metadata: Metadata = {
  title: "Documents",
  description: "Org-level documents not attached to a project",
};

export default function DocumentsPage() {
  return <DocumentsPageSurface />;
}
