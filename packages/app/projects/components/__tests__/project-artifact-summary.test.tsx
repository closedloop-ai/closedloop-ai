import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ProjectStatus,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import { TreeTruncationReason } from "@repo/api/src/types/project-tree";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTreeArtifact } from "../../../documents/lib/__tests__/tree-fixtures";
import { projectArtifactListRow } from "../../lib/project-artifact-list-adapter";
import { projectArtifactReadModel } from "../../lib/project-artifact-read-model";
import { ProjectArtifactSummary } from "../project-artifact-summary";

const mocks = vi.hoisted(() => ({
  bar: vi.fn(),
  costs: vi.fn(),
}));
vi.mock("../../../artifacts/components/artifact-bar", () => ({
  ArtifactBar: (props: unknown) => {
    mocks.bar(props);
    return null;
  },
}));
vi.mock("../../../documents/hooks/use-documents-costs", () => ({
  useDocumentsCosts: (...args: unknown[]) => mocks.costs(...args),
}));

const project: ProjectWithDetails = {
  id: "project",
  organizationId: "org",
  name: "Project",
  description: null,
  priority: null,
  status: ProjectStatus.InProgress,
  assigneeId: null,
  createdById: "user",
  slug: "PRO-1",
  targetDate: null,
  codebaseSummary: null,
  lastIndexedAt: null,
  settings: {},
  sortOrder: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  completionPercentage: 67,
  teams: [],
};
const document = makeTreeArtifact("document", ArtifactType.Document);
const branch = makeTreeArtifact("branch", ArtifactType.Branch);
const model = projectArtifactReadModel({
  nodes: [
    { root: document, children: [] },
    { root: branch, children: [] },
  ],
  externalParents: [],
});
const rows = [document, branch].map((artifact) =>
  projectArtifactListRow(artifact, null, project.name, Date.now())
);
const visibleMetricKeys = new Set([
  "project-completion",
  "artifact-count",
  "estimated-total-cost",
  "median-token-cost",
  "metric-five",
]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.costs.mockReturnValue({
    data: { totalEstimatedCost: 12, medianEstimatedCost: 6 },
    isError: false,
    isLoading: false,
  });
});
function mount(
  overrides: Partial<Parameters<typeof ProjectArtifactSummary>[0]> = {}
) {
  render(
    <ProjectArtifactSummary
      failed={false}
      loading={false}
      matchingArtifacts={rows}
      model={model}
      project={project}
      visibleMetricKeys={visibleMetricKeys}
      {...overrides}
    />
  );
  const props = mocks.bar.mock.lastCall?.[0] as {
    metrics: { key: string; value: string | number | null }[];
  };
  return Object.fromEntries(
    props.metrics.map((metric) => [metric.key, metric.value])
  );
}

describe("project summary cohort and unavailable states", () => {
  it("counts mixed matching artifacts while keeping completion over the project's canonical population", () => {
    const values = mount({ matchingArtifacts: [rows[1]] });
    expect(values["artifact-count"]).toBe(1);
    expect(values["project-completion"]).toBe("67%");
    expect(values["metric-five"]).toBeNull();
    expect(mocks.costs).toHaveBeenCalledWith([], {}, { enabled: false });
  });

  it("sends only matching document identities to existing cost attribution", () => {
    mount({ matchingArtifacts: [rows[0]] });
    expect(mocks.costs).toHaveBeenCalledWith(
      [document.id],
      {},
      { enabled: true }
    );
  });

  it("does not present a partial Document cost as the total for mixed artifacts", () => {
    const values = mount();
    expect(values["artifact-count"]).toBe(2);
    expect(values["estimated-total-cost"]).toBe("—");
    expect(values["median-token-cost"]).toBe("—");
    expect(mocks.costs).toHaveBeenCalledWith(
      [document.id],
      {},
      { enabled: false }
    );
  });

  it("distinguishes a genuine zero completion from an empty completion population", () => {
    expect(
      mount({ project: { ...project, completionPercentage: 0 } })[
        "project-completion"
      ]
    ).toBe("0%");
    expect(
      mount({
        project: {
          ...project,
          completionPercentage: 0,
          completionPopulationEmpty: true,
        },
      })["project-completion"]
    ).toBeNull();
  });

  it.each([
    { loading: true },
    { failed: true },
    {
      model: {
        ...model,
        truncation: {
          reasons: [TreeTruncationReason.NodeBudget],
          anchorsIncluded: 2,
          anchorsMatchedAtLeast: 3,
        },
      },
    },
  ])(
    "withholds counts and cost reads for an incomplete cohort: %j",
    (state) => {
      const values = mount(state);
      expect(values["artifact-count"]).toBeNull();
      expect(values["estimated-total-cost"]).toBe("—");
      expect(values["median-token-cost"]).toBe("—");
      expect(mocks.costs).toHaveBeenCalledWith(
        [document.id],
        {},
        { enabled: false }
      );
    }
  );

  it("keeps a failed cost read unknown without hiding a known artifact count", () => {
    mocks.costs.mockReturnValue({
      data: undefined,
      isError: true,
      isLoading: false,
    });
    const values = mount({ matchingArtifacts: [rows[0]] });
    expect(values["artifact-count"]).toBe(1);
    expect(values["estimated-total-cost"]).toBe("—");
    expect(values["median-token-cost"]).toBe("—");
  });
});
