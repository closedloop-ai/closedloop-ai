import type { ProjectTreeDetailsResponse } from "@repo/api/src/types/project-tree";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectTreeChildLoadState,
  useProjectTreeExpansionState,
} from "../project-tree-expansion-pages";

const mocks = vi.hoisted(() => ({
  childPages: vi.fn(),
  enabled: vi.fn(),
  merge: vi.fn(),
  parents: vi.fn(),
  rendered: vi.fn(),
  states: vi.fn(),
}));

vi.mock("@repo/app/shared/feature-flags/use-manual-artifact-ordering", () => ({
  useManualArtifactOrderingEnabled: () => mocks.enabled(),
}));
vi.mock(
  "@repo/app/projects/hooks/use-project-tree",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/projects/hooks/use-project-tree")
    >()),
    useProjectTreeExpansionBatch: (...args: unknown[]) =>
      mocks.childPages(...args),
  })
);
vi.mock("@repo/app/documents/lib/project-hierarchy-child-pages", () => ({
  hierarchyExpansionParentIds: (...args: unknown[]) => mocks.parents(...args),
  mergeProjectTreeExpansionPages: (...args: unknown[]) => mocks.merge(...args),
}));

const ROOT_TREE = {
  nodes: [],
  externalParents: [],
} as ProjectTreeDetailsResponse;
const CHILD_PAGE = {
  nodes: [],
  externalParents: [],
} as ProjectTreeDetailsResponse;
const MERGED_TREE = {
  nodes: [],
  externalParents: [],
} as ProjectTreeDetailsResponse;
const FLAT_CATEGORY_TREE = {
  nodes: [],
  externalParents: [],
} as ProjectTreeDetailsResponse;

function Harness({
  tree,
  expandedArtifactIds,
}: {
  tree: ProjectTreeDetailsResponse;
  expandedArtifactIds: ReadonlySet<string>;
}) {
  const { childLoadByParentId, expandedTree, expansionLoader } =
    useProjectTreeExpansionState("project-1", tree, expandedArtifactIds);
  mocks.rendered(expandedTree);
  mocks.states(childLoadByParentId);
  return <>{expansionLoader}</>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.parents.mockImplementation((tree: ProjectTreeDetailsResponse) =>
    tree === ROOT_TREE ? ["parent-1"] : []
  );
  mocks.childPages.mockReturnValue([{ data: [CHILD_PAGE] }]);
  mocks.merge.mockReturnValue(MERGED_TREE);
});

describe("bounded project child pages", () => {
  it("does not merge stale hierarchy children into a flat category tab", () => {
    const { rerender } = render(
      <Harness expandedArtifactIds={new Set(["parent-1"])} tree={ROOT_TREE} />
    );
    expect(mocks.rendered).toHaveBeenLastCalledWith(MERGED_TREE);
    expect(mocks.merge).toHaveBeenCalledWith(ROOT_TREE, [[CHILD_PAGE]]);

    rerender(
      <Harness expandedArtifactIds={new Set()} tree={FLAT_CATEGORY_TREE} />
    );
    expect(mocks.rendered).toHaveBeenLastCalledWith(FLAT_CATEGORY_TREE);
    expect(mocks.merge).toHaveBeenCalledTimes(1);
  });

  it("retains the affected parent's loading, failure, and retry without inventing empty children", () => {
    const refetch = vi.fn();
    mocks.childPages.mockReturnValue([{ isPending: true, refetch }]);
    const { rerender } = render(
      <Harness expandedArtifactIds={new Set(["parent-1"])} tree={ROOT_TREE} />
    );
    expect(mocks.rendered).toHaveBeenLastCalledWith(ROOT_TREE);
    expect(mocks.states.mock.lastCall?.[0].get("parent-1").state).toBe(
      ProjectTreeChildLoadState.Loading
    );

    mocks.childPages.mockReturnValue([{ isError: true, refetch }]);
    rerender(
      <Harness expandedArtifactIds={new Set(["parent-1"])} tree={ROOT_TREE} />
    );
    expect(mocks.rendered).toHaveBeenLastCalledWith(ROOT_TREE);
    const failed = mocks.states.mock.lastCall?.[0].get("parent-1");
    expect(failed.state).toBe(ProjectTreeChildLoadState.Error);
    failed.retry();
    expect(refetch).toHaveBeenCalledOnce();
  });
});
