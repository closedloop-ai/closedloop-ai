import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fireEvent, screen, userEvent, within } from "storybook/test";
import { initialCustomFields } from "./fixtures";
import { GenericArtifactTableDemo } from "./generic-artifact-table";
import type { DetailTab } from "./preview/components/generic-artifact-detail-shell";
import { type GenericArtifact, genericArtifacts } from "./preview/fixtures";
import { GenericArtifactPreview } from "./preview/generic-artifact-preview";

const meta = {
  title: "Composites v1.0/App Shell/Generic Artifact Surface",
  component: GenericArtifactTableDemo,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GenericArtifactTableDemo>;

export default meta;

type Story = StoryObj;

export const GenericArtifactParity: Story = {
  render: () => <GenericArtifactTableDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const columnId of PARITY_COLUMN_IDS) {
      await expect(
        canvasElement.querySelector(`[data-column-id="${columnId}"]`)
      ).not.toBeNull();
    }
    await expect(
      canvas.getByRole("button", { name: "Edit owner, currently empty" })
    ).toBeVisible();
    await expect(
      canvas.getAllByRole("button", { name: "Edit artifacts reference" })[0]
    ).toBeVisible();
  },
};

export const FullPortablePreview: Story = {
  globals: { viewport: { value: "1512-900" } },
  parameters: fixedPortablePreviewParameters(),
  render: () => <PortablePreviewStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Generic Artifact")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Filters" })).toBeVisible();
    await userEvent.click(
      canvas.getAllByText("Unified artifact experience")[0]!
    );
    await expect(
      canvas.getByText("FEA-2481 Unified artifact experience")
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Back to artifacts" })
    );
    await expect(canvas.getByRole("button", { name: "Filters" })).toBeVisible();
  },
};

export const FullPortablePreviewDark: Story = {
  globals: { viewport: { value: "1512-900" } },
  parameters: fixedPortablePreviewParameters(),
  render: () => <PortablePreviewStory dark />,
};

export const FullPortablePreviewNarrow: Story = {
  globals: { viewport: { value: "390-844" } },
  parameters: {
    ...fixedPortablePreviewParameters(),
    appCore: {
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    },
  },
  render: () => <PortablePreviewStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("columnheader", { name: "Name" })
    ).toBeVisible();
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(1);
    const rows = canvasElement.querySelectorAll("[data-grid-row]");
    await expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      await expect(row.querySelector('[data-slot="card"]')).toBeNull();
    }
  },
};

export const FullPortablePreviewNarrowDark: Story = {
  globals: { viewport: { value: "390-844" } },
  parameters: {
    ...fixedPortablePreviewParameters(),
    appCore: {
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    },
  },
  render: () => <PortablePreviewStory dark />,
};

/** Captured-main cards retained only while the responsive rollout is closed. */
export const FullPortablePreviewCardCompatibility: Story = {
  globals: { viewport: { value: "390-844" } },
  parameters: {
    ...fixedPortablePreviewParameters(),
    appCore: { enabledFlags: [] },
  },
  render: () => <PortablePreviewStory />,
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector('[data-slot="card"]')
    ).not.toBeNull();
    await expect(within(canvasElement).queryByRole("grid")).toBeNull();
  },
};

export const InteractionContract: Story = {
  render: () => <GenericArtifactTableDemo initialFields={[]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const rows = () =>
      Array.from(
        canvasElement.querySelectorAll<HTMLElement>("[data-grid-row-id]")
      ).map((row) => row.dataset.gridRowId);
    await expect(rows()).toEqual(["artifact-1", "artifact-2", "artifact-3"]);

    const favorite = canvas.getByRole("button", {
      name: "Remove Unified artifact experience from favorites",
    });
    await expect(favorite).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(favorite);
    await expect(
      canvas.getByRole("button", {
        name: "Add Unified artifact experience to favorites",
      })
    ).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(
      canvas.getByRole("button", { name: "Owner column options" })
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sort ascending" })
    );
    await expect(rows()).toEqual(["artifact-1", "artifact-3", "artifact-2"]);
  },
};

export const InlineEditingContract: Story = {
  render: () => <GenericArtifactTableDemo initialFields={[]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    fireEvent.click(
      canvas.getByRole("button", {
        name: "Edit artifact name for FEA-2481",
      })
    );
    const titleInput = canvas.getByRole("textbox", {
      name: "Edit artifact name for FEA-2481",
    });
    fireEvent.change(titleInput, {
      target: { value: "Unified artifact model" },
    });
    fireEvent.keyDown(titleInput, { key: "Enter" });
    await expect(canvas.getByText("Unified artifact model")).toBeVisible();

    await userEvent.click(
      canvas.getByRole("button", {
        name: "Edit status, currently In review",
      })
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Done" }));
    await expect(
      canvas.getAllByRole("button", {
        name: "Edit status, currently Done",
      })[0]
    ).toBeVisible();
  },
};

export const AddFieldContract: Story = {
  render: () => <GenericArtifactTableDemo initialFields={[]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    fireEvent.click(canvas.getByRole("button", { name: "Add field" }));
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: FIELD_TITLE_LABEL_PATTERN,
      }),
      { target: { value: "Confidence" } }
    );
    fireEvent.change(
      (await screen.findAllByPlaceholderText("Type an option name"))[0],
      { target: { value: "High" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Create field" }));
    await expect(canvas.getByText("Confidence")).toBeVisible();
    await expect(canvas.getByText("Repository")).toBeVisible();
    await expect(canvas.getByText("Creation cost")).toBeVisible();
    await expect(canvas.getByText("Changes")).toBeVisible();
    await expect(canvas.getByText("$42.18")).toBeVisible();
    await expect(canvas.getByText("+184")).toBeVisible();
    await expect(canvas.getByText("−42")).toBeVisible();
  },
};

export const ReferenceEditingContract: Story = {
  render: () => (
    <GenericArtifactTableDemo initialFields={REFERENCE_CONTRACT_FIELDS} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    fireEvent.click(
      canvas.getAllByRole("button", { name: "Edit issues reference" })[0]
    );
    const issuesSearch = await screen.findByRole("textbox", {
      name: "Search issues references",
    });
    const issuesPopover = issuesSearch.closest(
      "[data-radix-popper-content-wrapper]"
    );
    await expect(issuesPopover).not.toBeNull();
    const issues = within(issuesPopover as HTMLElement);
    await expect(issues.getByText("FEA-2481")).toBeVisible();
    await expect(issues.getByText("ISS-4382")).toBeVisible();
    await expect(issues.queryByText("BRN-grid-table-v2")).toBeNull();
    await expect(issues.queryByText("SES-7B91")).toBeNull();
    fireEvent.keyDown(issuesSearch, { key: "Escape" });

    fireEvent.click(
      canvas.getAllByRole("button", { name: "Edit artifacts reference" })[0]
    );
    const artifactsSearch = await screen.findByRole("textbox", {
      name: "Search artifacts references",
    });
    const artifactsPopover = artifactsSearch.closest(
      "[data-radix-popper-content-wrapper]"
    );
    await expect(artifactsPopover).not.toBeNull();
    const artifacts = within(artifactsPopover as HTMLElement);
    await expect(artifacts.getByText("ISS-4382")).toBeVisible();
    await expect(artifacts.getByText("BRN-grid-table-v2")).toBeVisible();
    await expect(artifacts.getByText("SES-7B91")).toBeVisible();
    await expect(artifacts.getByText("3 selected")).toBeVisible();
  },
};

const FIELD_TITLE_LABEL_PATTERN = /Field title/;
const REFERENCE_CONTRACT_FIELDS = initialCustomFields.filter((field) =>
  field.type.startsWith("Reference")
);
const PARITY_COLUMN_IDS = [
  "priority",
  "model",
  "repository",
  "lineChanges",
  "custom-stage",
  "custom-capabilities",
  "custom-due-date",
  "custom-reviewer",
  "custom-parent-artifact",
  "custom-is-implemented-by",
  "custom-cycle-time",
  "custom-summary",
  "custom-revision-count",
] as const;

function PortablePreviewStory({ dark = false }: Readonly<{ dark?: boolean }>) {
  const [artifacts, setArtifacts] =
    useState<readonly GenericArtifact[]>(genericArtifacts);
  const [selected, setSelected] = useState<GenericArtifact | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>("artifact");
  const openArtifact = (artifact: GenericArtifact) => {
    setSelected(artifact);
    setCommentsOpen(false);
    setActiveDetailTab("artifact");
  };
  const updateArtifacts = (next: readonly GenericArtifact[]) => {
    setArtifacts(next);
    setSelected((current) =>
      current
        ? (next.find((artifact) => artifact.id === current.id) ?? current)
        : current
    );
  };

  return (
    <div className={dark ? "dark" : undefined}>
      <GenericArtifactPreview
        activeDetailTab={activeDetailTab}
        artifacts={artifacts}
        commentsOpen={commentsOpen}
        onActiveDetailTabChange={setActiveDetailTab}
        onArtifactsChange={updateArtifacts}
        onBack={() => setSelected(null)}
        onCommentsOpenChange={setCommentsOpen}
        onOpenArtifact={openArtifact}
        selected={selected}
      />
    </div>
  );
}

function fixedPortablePreviewParameters() {
  return {
    controls: { disable: true },
    docs: {
      description: {
        story:
          "Controls are disabled because this composed preview intentionally renders the approved fixed fixture matrix.",
      },
    },
  };
}
