import { DocumentType } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { RowEditContext } from "@repo/app/documents/components/table/row-edit-context";
import { LabelledStates } from "@repo/app/shared/storybook/story-states";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { makeProject } from "@repo/app/shared/test-fixtures/project";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { ParentCell, ProjectCell, TypeCell, UpdatedCell } from "./static-cells";

/**
 * The four read-only cells of the document table's shared cell layer. They were
 * built for the artifacts table but are not table-specific — anything rendering
 * a `DocumentRowItem` gets the same type label, parent link, project link, and
 * relative timestamp for free rather than re-deriving them (ISS-6386).
 *
 * The two link cells are the reason this showcase exists: each has a plain-text
 * branch, and picking the wrong one produces a link to nowhere.
 */
const meta = {
  title: "Primitives v1.0/Data Display/Tables/Static Cells",
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const PRD_ROW: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({ title: "Artifact cell primitives" }),
};

const PLAN_ROW: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({
    id: "artifact-2",
    title: "Cell convergence plan",
    type: DocumentType.ImplementationPlan,
  }),
};

const FEATURE_ROW: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({
    id: "artifact-3",
    title: "Story the cell layer",
    type: DocumentType.Feature,
  }),
};

const PROJECT_ROW: DocumentRowItem = {
  kind: "project",
  data: makeProject({ name: "Apollo" }),
};

/** A project with no team has no team-scoped route to link its name to. */
const TEAMLESS_PROJECT_ROW: DocumentRowItem = {
  kind: "project",
  data: makeProject({ name: "Apollo (no team)", teams: [] }),
};

/**
 * Each row's type as a plain colored label. Type is low-emphasis metadata, so
 * it deliberately reads as a colored string rather than a filled badge — the
 * badge is reserved for genuine status emphasis (FEA-3947).
 */
export const Type: Story = {
  render: () => (
    <CellRow>
      <TypeCell item={PRD_ROW} />
      <TypeCell item={PLAN_ROW} />
      <TypeCell item={FEATURE_ROW} />
    </CellRow>
  ),
};

/**
 * The parent cell's three states. A parent with a route is a link; a parent
 * without one is the same string as plain text, not a link to nowhere; and a
 * row with no parent at all falls back to the shared em-dash.
 */
export const Parent: Story = {
  render: () => (
    <LabelledStates
      rows={[
        [
          "Linked",
          <RowEditContext.Provider
            key="linked"
            value={{
              parentHref: "/artifacts/parent-prd",
              parentTitle: "Parent PRD",
            }}
          >
            <ParentCell item={PRD_ROW} />
          </RowEditContext.Provider>,
        ],
        [
          "No route",
          <RowEditContext.Provider
            key="unlinked"
            value={{ parentHref: null, parentTitle: "Parent PRD" }}
          >
            <ParentCell item={PRD_ROW} />
          </RowEditContext.Provider>,
        ],
        [
          "No parent",
          <RowEditContext.Provider key="none" value={{}}>
            <ParentCell item={PRD_ROW} />
          </RowEditContext.Provider>,
        ],
      ]}
    />
  ),
};

/**
 * The project cell resolves its own route from the project's first team, so a
 * project with no team renders its name as plain text. The alternative — a
 * link built from an absent team id — is the bug this branch prevents.
 */
export const Project: Story = {
  render: () => (
    <LabelledStates
      rows={[
        ["With a team", <ProjectCell item={PROJECT_ROW} key="team" />],
        ["No team", <ProjectCell item={TEAMLESS_PROJECT_ROW} key="teamless" />],
        [
          "Document's project",
          <ProjectCell item={PRD_ROW} key="from-document" />,
        ],
      ]}
    />
  ),
};

/**
 * The relative timestamp, rendered through the canonical `formatRelativeTime`.
 * Every row below is the same cell reading a different `updatedAt`, which is
 * the point: one formatter, one treatment, on every table that shows this type.
 */
export const Updated: Story = {
  render: () => (
    <LabelledStates
      rows={[
        [
          "Minutes",
          <UpdatedCell item={rowUpdatedMinutesAgo(4)} key="minutes" />,
        ],
        ["Hours", <UpdatedCell item={rowUpdatedMinutesAgo(180)} key="hours" />],
        ["Days", <UpdatedCell item={rowUpdatedMinutesAgo(4320)} key="days" />],
      ]}
    />
  ),
};

const MINUTE_MS = 60_000;

function rowUpdatedMinutesAgo(minutes: number): DocumentRowItem {
  return {
    kind: "document",
    data: makeArtifact({
      updatedAt: new Date(Date.now() - minutes * MINUTE_MS),
    }),
  };
}

function CellRow({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="flex items-center border-y">{children}</div>;
}
