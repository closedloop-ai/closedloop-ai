import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentStatus } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  RowEditContext,
  type RowEditHandlers,
} from "@repo/app/documents/components/table/row-edit-context";
import { LabelledStates } from "@repo/app/shared/storybook/story-states";
import {
  makeArtifact,
  makeRawArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { makeProject } from "@repo/app/shared/test-fixtures/project";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { NameCell } from "./name-cell";

/**
 * The primary title cell on every Documents table row (ISS-6386 layer).
 * `NameCell` itself only dispatches on `item.kind` — the per-kind layout (a
 * project's completion ring, a document's editable status control, a
 * branch/session's derived status glyph) lives in the three subcomponents
 * below it, so the dispatch is what these stories exist to prove: the same
 * cluster of leading affordances (rank slot, checkbox, chevron, type icon,
 * slug, status, title) renders correctly for every row kind this table holds.
 */
const meta = {
  title: "Composites v1.0/Documents/Name Cell",
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const DOCUMENT_ROW: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({
    id: "artifact-vendor-filters",
    title: "Vendor Directory Search Filters",
    slug: "PRD-482",
    status: DocumentStatus.InReview,
  }),
};

const EDITABLE: RowEditHandlers = {
  onUpdateStatus: () => undefined,
};

/**
 * The document status glyph is one of two controls depending on whether the
 * host surface can save (ISS-6386's editable/read-only pairing, same as
 * `edit-cells.stories.tsx`): a plain hover tooltip when `onUpdateStatus` is
 * absent from `RowEditContext`, or the full status dropdown when it is
 * supplied. Both read the same `item.data.status`.
 */
export const DocumentRow: Story = {
  render: () => (
    <LabelledStates
      rows={[
        [
          "Status tooltip",
          withEditContext(
            <NameCell
              isSelected={false}
              item={DOCUMENT_ROW}
              showCheckbox={false}
            />,
            {}
          ),
        ],
        [
          // Every real caller supplies an `href` (list -> detail navigation);
          // omitting it everywhere else in this file is the rare fallback
          // (`NameLink` renders a plain non-interactive `div`), so this row is
          // the one that shows the normal, Link-wrapped title.
          "Status menu",
          withEditContext(
            <NameCell
              href="/prd-482"
              isSelected={false}
              item={DOCUMENT_ROW}
              showCheckbox={false}
            />,
            EDITABLE
          ),
        ],
      ]}
    />
  ),
};

const PROJECT_ROW: DocumentRowItem = {
  kind: "project",
  data: makeProject({
    id: "project-vendor-directory",
    name: "Vendor Directory Refresh",
    slug: "PRO-14",
    completionPercentage: 62,
  }),
};

const EMPTY_PROJECT_ROW: DocumentRowItem = {
  kind: "project",
  data: makeProject({
    id: "project-onboarding-kit",
    name: "New Client Onboarding Kit",
    slug: "PRO-21",
    completionPercentage: 0,
    completionPopulationEmpty: true,
  }),
};

/**
 * A project row's completion ring reads `completionPopulationEmpty` before
 * `completionPercentage` (ISS-4679): a project with no documents or issues
 * yet shows the muted dash `ProjectNameCell` shares with the empty-population
 * branch/session dash below, not a misleading solid 0% ring.
 */
export const ProjectRow: Story = {
  render: () => (
    <LabelledStates
      rows={[
        [
          // Real `href` (see the `DocumentRow` note above) so the Link-wrapped
          // title renders instead of the hrefless fallback `div`.
          "Populated",
          <NameCell
            href="/pro-14"
            isSelected={false}
            item={PROJECT_ROW}
            key="populated"
            showCheckbox={false}
          />,
        ],
        [
          "Empty population",
          <NameCell
            isSelected={false}
            item={EMPTY_PROJECT_ROW}
            key="empty"
            showCheckbox={false}
          />,
        ],
      ]}
    />
  ),
};

const BRANCH_ROW: DocumentRowItem = {
  kind: "branch",
  data: makeRawArtifact(ArtifactType.Branch, {
    id: "branch-invoice-export",
    name: "Fix invoice PDF export truncation",
    status: GitHubPRState.Open,
  }),
};

const RUNNING_SESSION_ROW: DocumentRowItem = {
  kind: "session",
  data: makeRawArtifact(ArtifactType.Session, {
    id: "session-onboarding-copy",
    name: "Regenerate onboarding email copy",
    status: SESSION_STATUS.ACTIVE,
  }),
};

const INACTIVE_SESSION_ROW: DocumentRowItem = {
  kind: "session",
  data: makeRawArtifact(ArtifactType.Session, {
    id: "session-backup-verification",
    name: "Nightly backup verification",
    status: SESSION_STATUS.INACTIVE,
  }),
};

const ERROR_SESSION_ROW: DocumentRowItem = {
  kind: "session",
  data: makeRawArtifact(ArtifactType.Session, {
    id: "session-search-index-rebuild",
    name: "Rebuild search index",
    status: SESSION_STATUS.ERROR,
  }),
};

const MERGED_BRANCH_ROW: DocumentRowItem = {
  kind: "branch",
  data: makeRawArtifact(ArtifactType.Branch, {
    id: "branch-tenant-id-column",
    name: "Add tenant_id column to invoices",
    status: GitHubPRState.Merged,
  }),
};

const CLOSED_BRANCH_ROW: DocumentRowItem = {
  kind: "branch",
  data: makeRawArtifact(ArtifactType.Branch, {
    id: "branch-legacy-webhook-cleanup",
    name: "Remove legacy webhook handler",
    status: GitHubPRState.Closed,
  }),
};

/**
 * Branch and session rows have no editable status — `ArtifactNameCell` draws
 * a derived glyph instead (ISS-8694): a plain `StatusIcon` for a status that
 * speaks for itself (an open PR, a running session).
 *
 * `BRANCH_STATUS_TO_ICON` has three real states (Open/Merged/Closed) and
 * `SESSION_STATUS_TO_ICON` has three (Active/Inactive/Error since ISS-10364
 * retired Waiting and Stale) — every one of them gets a row here so a gap in
 * either exhaustive map shows up as a missing state rather than a passing
 * test over an unseen branch.
 */
export const ArtifactRow: Story = {
  render: () => (
    <LabelledStates
      rows={[
        [
          // Real `href` (see the `DocumentRow` note above) so the
          // Link-wrapped title renders instead of the hrefless fallback `div`.
          "Branch, open",
          <NameCell
            href="/branches/branch-invoice-export"
            isSelected={false}
            item={BRANCH_ROW}
            key="branch"
            showCheckbox={false}
          />,
        ],
        [
          "Branch, merged",
          <NameCell
            isSelected={false}
            item={MERGED_BRANCH_ROW}
            key="branch-merged"
            showCheckbox={false}
          />,
        ],
        [
          "Branch, closed",
          <NameCell
            isSelected={false}
            item={CLOSED_BRANCH_ROW}
            key="branch-closed"
            showCheckbox={false}
          />,
        ],
        [
          "Session, running",
          <NameCell
            isSelected={false}
            item={RUNNING_SESSION_ROW}
            key="running"
            showCheckbox={false}
          />,
        ],
        [
          "Session, completed",
          <NameCell
            isSelected={false}
            item={INACTIVE_SESSION_ROW}
            key="completed"
            showCheckbox={false}
          />,
        ],
        [
          "Session, failed",
          <NameCell
            isSelected={false}
            item={ERROR_SESSION_ROW}
            key="failed"
            showCheckbox={false}
          />,
        ],
      ]}
    />
  ),
};

/**
 * The selection checkbox (shared by project and document rows) reveals on
 * row hover for a mouse — invisible until then — so the always-visible
 * "unselected" case below is shown the way a real bulk-select surface keeps
 * it visible: `selectMode`. A checked row stays visible without it.
 */
export const Selection: Story = {
  render: () => (
    <LabelledStates
      rows={[
        [
          "Unselected, select mode",
          <NameCell
            isSelected={false}
            item={DOCUMENT_ROW}
            key="unselected"
            onSelectionChange={() => undefined}
            selectMode
            showCheckbox
          />,
        ],
        [
          "Selected",
          <NameCell
            isSelected
            item={DOCUMENT_ROW}
            key="selected"
            onSelectionChange={() => undefined}
            showCheckbox
          />,
        ],
      ]}
    />
  ),
};

/**
 * Tree affordances on a document row: the chevron toggles open/closed when a
 * row has children, and a child one level down gets an `IndentSpacer` the
 * same width as the chevron/rank slot so it lines up under its parent's icon
 * column rather than the chevron itself.
 */
export const Hierarchy: Story = {
  render: () => (
    <LabelledStates
      rows={[
        [
          "Collapsed",
          <NameCell
            isExpanded={false}
            isSelected={false}
            item={DOCUMENT_ROW}
            key="collapsed"
            onToggleExpand={() => undefined}
            showCheckbox={false}
          />,
        ],
        [
          "Expanded",
          <NameCell
            isExpanded
            isSelected={false}
            item={DOCUMENT_ROW}
            key="expanded"
            onToggleExpand={() => undefined}
            showCheckbox={false}
          />,
        ],
        [
          "Indented child",
          <NameCell
            indentDepth={1}
            isSelected={false}
            item={DOCUMENT_ROW}
            key="indented"
            showCheckbox={false}
          />,
        ],
      ]}
    />
  ),
};

function withEditContext(
  cell: ReactNode,
  handlers: RowEditHandlers
): ReactNode {
  return (
    <RowEditContext.Provider value={handlers}>{cell}</RowEditContext.Provider>
  );
}
