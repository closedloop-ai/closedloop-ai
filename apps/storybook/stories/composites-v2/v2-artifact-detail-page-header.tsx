import type { SessionDetailPageHeaderParts } from "@repo/app/agents/components/detail/detail-design/session-detail-design-preview";
import type { BranchDetailPageHeaderParts } from "@repo/app/branches/components/detail-design/branch-detail-design-preview";
import { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import type { DocumentDetailPageHeaderParts } from "@repo/app/documents/components/detail-design/document-detail-design-shell";
import { Header } from "@/app/(authenticated)/components/header";
import { LIVE_ORG_SLUG } from "../surfaces-v2/live-route";

// The page header row of the PRD-751 Session, Branch, Document and Issue
// Detail pages, as the web-master generic artifact prototype lays it out: the
// app's route header (sidebar toggle, breadcrumbs) with the comments toggle at
// its end. Shared by the Surfaces pages and their Composites Page
// Header sections. Document and Issue name the artifact by slug and title,
// and on the Artifact tab put Add comment just before the toggle (Nerys,
// 2026-10-22).

export function SessionDetailPageHeader({
  commentsToggle,
  overflowMenu,
  status,
  title,
}: SessionDetailPageHeaderParts) {
  return (
    <Header
      afterBreadcrumbs={
        <div className="flex items-center gap-2.5">
          {overflowMenu}
          {status}
        </div>
      }
      breadcrumbs={[
        { label: BranchBackLabel.Sessions, href: `/${LIVE_ORG_SLUG}/sessions` },
        { label: title },
      ]}
    >
      {commentsToggle}
    </Header>
  );
}

export function BranchDetailPageHeader({
  commentsToggle,
  title,
}: BranchDetailPageHeaderParts) {
  return (
    <Header
      breadcrumbs={[
        { label: BranchBackLabel.Branches, href: `/${LIVE_ORG_SLUG}/branches` },
        { label: title },
      ]}
    >
      {commentsToggle}
    </Header>
  );
}

/**
 * The header's end on a Document or Issue: Add comment (Artifact tab only),
 * then the comments toggle.
 */
function HeaderComments({
  addComment,
  commentsToggle,
}: DocumentDetailPageHeaderParts) {
  return addComment ? (
    <div className="flex items-center gap-2">
      {addComment}
      {commentsToggle}
    </div>
  ) : (
    commentsToggle
  );
}

/** The breadcrumb that names a document: its slug, then its title. */
function documentCrumb({ slug, title }: DocumentDetailPageHeaderParts) {
  return `${slug} ${title}`;
}

export function DocumentDetailPageHeader(parts: DocumentDetailPageHeaderParts) {
  return (
    <Header
      breadcrumbs={[
        { label: "Documents", href: `/${LIVE_ORG_SLUG}/documents` },
        { label: documentCrumb(parts) },
      ]}
    >
      <HeaderComments {...parts} />
    </Header>
  );
}

export function IssueDetailPageHeader(parts: DocumentDetailPageHeaderParts) {
  return (
    <Header
      breadcrumbs={[
        { label: "Issues", href: `/${LIVE_ORG_SLUG}/issues` },
        { label: documentCrumb(parts) },
      ]}
    >
      <HeaderComments {...parts} />
    </Header>
  );
}
