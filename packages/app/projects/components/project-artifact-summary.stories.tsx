import { ArtifactType } from "@repo/api/src/types/artifact";
import type { Meta, StoryObj } from "@storybook/react";
import { projectArtifactListRow } from "../lib/project-artifact-list-adapter";
import { projectArtifactReadModel } from "../lib/project-artifact-read-model";
import {
  projectStoryArtifact as artifact,
  projectStoryNow as now,
  projectStoryProject as project,
} from "./project-artifact-story-fixtures";
import {
  PROJECT_ARTIFACT_METRICS,
  ProjectArtifactSummary,
} from "./project-artifact-summary";

const model = projectArtifactReadModel({
  nodes: [{ root: artifact, children: [] }],
  externalParents: [],
});
const rows = [
  projectArtifactListRow(artifact, null, project.name, now.getTime()),
];
const costRoute = {
  method: "POST",
  path: "/documents/costs",
  respond: () => ({
    artifacts: [{ artifactId: artifact.id, totalEstimatedCost: 0 }],
    totalEstimatedCost: 0,
    medianEstimatedCost: 0,
  }),
};

const meta = {
  title: "Composites/Your Teams/Project Detail/Project Artifact Summary",
  component: ProjectArtifactSummary,
  tags: ["preview", "autodocs"],
  parameters: { layout: "fullscreen", appCore: { apiRoutes: [costRoute] } },
  args: {
    project,
    model,
    matchingArtifacts: rows,
    visibleMetricKeys: new Set(
      PROJECT_ARTIFACT_METRICS.map((metric) => metric.key)
    ),
    loading: false,
    failed: false,
  },
  argTypes: {
    loading: { control: "boolean" },
    failed: { control: "boolean" },
    // Canonical identity/read-model fixtures are exercised by named states.
    project: { control: false },
    model: { control: false },
    matchingArtifacts: { control: false },
    visibleMetricKeys: { control: false },
  },
} satisfies Meta<typeof ProjectArtifactSummary>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = {
  args: {
    project: { ...project, completionPopulationEmpty: true },
    model: projectArtifactReadModel(undefined),
    matchingArtifacts: [],
  },
};
export const ErrorState: Story = { name: "Error", args: { failed: true } };
export const UnknownCost: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          ...costRoute,
          respond: () => ({ artifacts: [{ artifactId: artifact.id }] }),
        },
      ],
    },
  },
};
export const MixedArtifacts: Story = {
  args: {
    model: projectArtifactReadModel({
      nodes: [
        { root: { ...artifact, type: ArtifactType.Branch }, children: [] },
      ],
      externalParents: [],
    }),
  },
};
