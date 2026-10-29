import { ArtifactType } from "@repo/api/src/types/artifact";
import type { Meta, StoryObj } from "@storybook/react";
import type { FixtureRoute } from "../../shared/storybook/fixture-fetch";
import { BranchProjectValue } from "./branch-project-value";

/**
 * ISS-10995: the Branch Details tab's Project row, under `AppCoreStoryProviders`
 * so the picker runs its real `useProjects` / `useBatchMoveArtifacts` ports
 * against the fixture transport below.
 *
 * What these stories pin that the suite cannot: the ghost trigger's geometry
 * beside the Priority and Tags triggers in the same column, and that a locked
 * viewer's row reads as a value or a dash rather than an empty picker.
 */
const ARTIFACT_ID = "33333333-3333-4333-8333-333333333331";
const PROJECT_ID = "44444444-4444-4444-8444-444444444441";

const projectRoutes: FixtureRoute[] = [
  {
    method: "GET",
    path: "/projects",
    respond: () => [
      { id: PROJECT_ID, name: "Desktop MLP", slug: "PRO-1" },
      {
        id: "44444444-4444-4444-8444-444444444442",
        name: "Branches",
        slug: "PRO-2",
      },
    ],
  },
  {
    method: "POST",
    path: "/artifact-links/batch-move",
    respond: () => ({
      movedArtifacts: [{ id: ARTIFACT_ID, type: ArtifactType.Branch }],
    }),
  },
];

const meta: Meta<typeof BranchProjectValue> = {
  title: "Primitives v1.0/Data Display/Branch Project Value",
  component: BranchProjectValue,
  tags: ["deprecated", "autodocs"],
  parameters: { appCore: { apiRoutes: projectRoutes }, layout: "centered" },
  argTypes: {
    readOnly: {
      control: "boolean",
      description: "The host locked this viewer out; renders the name alone.",
    },
    projectName: { control: "text" },
    projectId: {
      control: "inline-radio",
      options: [PROJECT_ID, null],
      description: "`null` is a branch filed into no project.",
    },
    artifactId: {
      control: "inline-radio",
      options: [ARTIFACT_ID, null],
      description:
        "`null` is a producer that omitted `artifactId`; `batch-move` has nothing to write against, so no picker is offered.",
    },
  },
  args: {
    artifactId: ARTIFACT_ID,
    projectId: PROJECT_ID,
    projectName: "Desktop MLP",
    readOnly: false,
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/** Filed into a project, and changeable — but not clearable, as no route can. */
export const Filed: Story = {};

/** Filed into no project. The row is where one gets set, so it still draws. */
export const Unfiled: Story = {
  args: { projectId: null, projectName: null },
};

/** Offline or without permission: the name, with no control beside it. */
export const ReadOnly: Story = {
  args: { readOnly: true },
};

/** Locked AND unfiled — the dash, never an empty picker claiming a read. */
export const ReadOnlyUnfiled: Story = {
  args: { projectId: null, projectName: null, readOnly: true },
};

/**
 * A producer that omitted `artifactId` (`BranchPageDetail.id` is then
 * `encodeBranchId(…)`, not an artifact UUID). The name still shows, so the row
 * reports what it read rather than going blank.
 */
export const NoArtifactId: Story = {
  args: { artifactId: null },
};
