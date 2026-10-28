import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { IssueStatus } from "@repo/loops-api/document";
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it, vi } from "vitest";
import { ArtifactCell } from "../../../packages/app/shared/components/generic-artifact-surface/artifact-cell";
import {
  type ArtifactRow,
  ArtifactStatus,
  initialArtifactRows,
  initialCustomFields,
} from "../../../packages/app/shared/components/generic-artifact-surface/fixtures";
import { cloneArtifact } from "../../../packages/app/shared/components/generic-artifact-surface/model";

const [firstArtifact, , thirdArtifact] = initialArtifactRows;

const EDIT_STAGE_CURRENTLY_BUILD_PATTERN = /edit stage, currently build/i;
const EDIT_PRIORITY_CURRENTLY_HIGH_PATTERN = /edit priority, currently high/i;

function renderArtifactCell({
  artifact,
  columnId,
  customFields = [],
  onArtifactChange = vi.fn(),
}: {
  artifact: ArtifactRow;
  columnId: string;
  customFields?: readonly CustomFieldDefinition[];
  onArtifactChange?: (
    artifactId: string,
    patch: Partial<ArtifactRow>,
    message?: string
  ) => void;
}) {
  const Story = composeStory(
    {
      render: () => (
        <ArtifactCell
          artifact={artifact}
          columnId={columnId}
          customFields={customFields}
          onArtifactChange={onArtifactChange}
        />
      ),
    },
    { title: "Test/ArtifactCell", component: ArtifactCell }
  );
  return { Story, onArtifactChange };
}

describe("ArtifactCell", () => {
  it("dispatches to CustomFieldCell when columnId matches a custom field, before reaching the switch", async () => {
    const artifact = cloneArtifact(firstArtifact);
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "custom-stage",
      customFields: initialCustomFields,
    });
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(EDIT_STAGE_CURRENTLY_BUILD_PATTERN)
    ).toBeTruthy();
  });

  it("renders EditableOwnerTableCell for the owner column", async () => {
    const artifact = cloneArtifact(firstArtifact);
    const { Story } = renderArtifactCell({ artifact, columnId: "owner" });
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(`Edit owner, currently ${artifact.owner.name}`)
    ).toBeTruthy();
  });

  it("renders EditablePeopleTableCell for the collaborators column", async () => {
    const artifact = cloneArtifact(firstArtifact);
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "collaborators",
    });
    await Story.run();
    const screen = within(document.body);
    const names = artifact.collaborators.map((person) => person.name);
    expect(
      screen.getByLabelText(`Edit collaborators: ${names.join(", ")}`)
    ).toBeTruthy();
  });

  it("renders EditableStatusTableCell for the status column", async () => {
    const artifact = cloneArtifact(firstArtifact);
    const { Story } = renderArtifactCell({ artifact, columnId: "status" });
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(`Edit status, currently ${artifact.status}`)
    ).toBeTruthy();
  });

  it("clears provider evidence when an inline status edit becomes authoritative", async () => {
    const artifact = {
      ...cloneArtifact(firstArtifact),
      statusRaw: IssueStatus.InReview,
    };
    const onArtifactChange = vi.fn();
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "status",
      onArtifactChange,
    });
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(
      screen.getByRole("button", {
        name: `Edit status, currently ${artifact.status}`,
      })
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: ArtifactStatus.Done })
    );

    expect(onArtifactChange).toHaveBeenCalledWith(
      artifact.id,
      { status: ArtifactStatus.Done, statusRaw: undefined },
      "Status updated"
    );
  });

  it("renders EditablePriorityTableCell for the priority column", async () => {
    const artifact = cloneArtifact(firstArtifact); // priority: High
    const { Story } = renderArtifactCell({ artifact, columnId: "priority" });
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(EDIT_PRIORITY_CURRENTLY_HIGH_PATTERN)
    ).toBeTruthy();
  });

  it("renders a non-empty TableReferenceListCell for the relatedSessions column", async () => {
    const artifact = cloneArtifact(firstArtifact); // relatedSessions has 3 entries
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "relatedSessions",
    });
    await Story.run();
    expect(document.querySelector('[data-slot="grid-empty-value"]')).toBeNull();
  });

  it("renders GridEmptyValue for the relatedSessions column when the list is empty", async () => {
    const artifact = cloneArtifact(thirdArtifact); // relatedSessions: []
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "relatedSessions",
    });
    await Story.run();
    expect(
      document.querySelector('[data-slot="grid-empty-value"]')
    ).not.toBeNull();
  });

  it("renders TableCountCell for the comments column", async () => {
    const artifact = cloneArtifact(firstArtifact);
    const { Story } = renderArtifactCell({ artifact, columnId: "comments" });
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByRole("button", { name: `${artifact.comments} comments` })
    ).toBeTruthy();
  });

  it("renders TableDateCell for the updated column", async () => {
    const artifact = cloneArtifact(firstArtifact);
    const { Story } = renderArtifactCell({ artifact, columnId: "updated" });
    await Story.run();
    const screen = within(document.body);
    expect(screen.getByText(artifact.updated)).toBeTruthy();
  });

  it("renders TableVersionCell for the currentVersion column", async () => {
    const artifact = cloneArtifact(firstArtifact);
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "currentVersion",
    });
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByRole("button", {
        name: `Open version ${artifact.currentVersion}`,
      })
    ).toBeTruthy();
  });

  it("renders EditableTagsTableCell for the tags column", async () => {
    const artifact = cloneArtifact(firstArtifact);
    const { Story } = renderArtifactCell({ artifact, columnId: "tags" });
    await Story.run();
    const screen = within(document.body);
    const labels = artifact.tags.map((tag) => tag.label).join(", ");
    expect(screen.getByLabelText(`Edit tags: ${labels}`)).toBeTruthy();
  });

  it("renders TableRepositoryCell with an open action when repository is set", async () => {
    const artifact = cloneArtifact(firstArtifact); // repository set
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "repository",
    });
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByRole("button", {
        name: `Open ${artifact.repository} repository`,
      })
    ).toBeTruthy();
  });

  it("renders TableRepositoryCell as GridEmptyValue with no action when repository is null", async () => {
    const artifact = cloneArtifact(thirdArtifact); // repository: null
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "repository",
    });
    await Story.run();
    const screen = within(document.body);
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      document.querySelector('[data-slot="grid-empty-value"]')
    ).not.toBeNull();
  });

  it("renders TableModelCell for the model column", async () => {
    const artifact = cloneArtifact(firstArtifact);
    const { Story } = renderArtifactCell({ artifact, columnId: "model" });
    await Story.run();
    const screen = within(document.body);
    expect(screen.getByText(artifact.model)).toBeTruthy();
  });

  it("renders a formatted currency value for the creationCost column when set", async () => {
    const artifact = cloneArtifact(firstArtifact); // creationCost: 42.18
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "creationCost",
    });
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByText(`$${(artifact.creationCost ?? 0).toFixed(2)}`)
    ).toBeTruthy();
    expect(document.querySelector('[data-slot="grid-empty-value"]')).toBeNull();
  });

  it("renders GridEmptyValue for the creationCost column when null", async () => {
    const artifact = cloneArtifact(thirdArtifact); // creationCost: null
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "creationCost",
    });
    await Story.run();
    expect(
      document.querySelector('[data-slot="grid-empty-value"]')
    ).not.toBeNull();
  });

  it("renders TableChangeCell with an additions/deletions label for the lineChanges column when set", async () => {
    const artifact = cloneArtifact(firstArtifact); // additions: 184, deletions: 42
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "lineChanges",
    });
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(
        `${artifact.additions} additions, ${artifact.deletions} deletions`
      )
    ).toBeTruthy();
  });

  it("renders GridEmptyValue for the lineChanges column when both additions and deletions are null", async () => {
    const artifact = cloneArtifact(thirdArtifact); // additions/deletions: null
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "lineChanges",
    });
    await Story.run();
    expect(
      document.querySelector('[data-slot="grid-empty-value"]')
    ).not.toBeNull();
  });

  it("renders nothing for an unrecognized columnId", async () => {
    const artifact = cloneArtifact(firstArtifact);
    const { Story } = renderArtifactCell({
      artifact,
      columnId: "not-a-real-column",
    });
    await Story.run();
    const root = document.getElementById("storybook-root");
    expect(root?.children.length ?? 0).toBe(0);
  });
});
