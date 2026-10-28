import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  currentProjectArtifactListView as currentView,
  mountProjectArtifactList as mount,
  projectArtifactListMocks,
  resetProjectArtifactListMocks,
} from "./support/project-artifact-list-live-harness";

const mocks = projectArtifactListMocks();

beforeEach(resetProjectArtifactListMocks);

describe("ProjectArtifactList default group when manual ordering resolves late (ISS-13007)", () => {
  it("moves an untouched default group to None and renders the hierarchy tree", async () => {
    mocks.portableSurfaceEnabled = true;
    mocks.flagEnabled = false;
    mocks.realView = true;
    const mounted = mount("");
    expect(currentView().controller.groupBy).toBe("status");

    mocks.flagEnabled = true;
    act(() => mounted.rerender());

    await waitFor(() => expect(currentView().controller.groupBy).toBe("none"));
    await screen.findByTestId("project-hierarchy-host");
  });

  it("keeps an explicit group=status in the URL even though it equals the old default", () => {
    mocks.portableSurfaceEnabled = true;
    mocks.flagEnabled = false;
    mocks.realView = true;
    const mounted = mount("group=status");
    expect(currentView().controller.groupBy).toBe("status");

    mocks.flagEnabled = true;
    act(() => mounted.rerender());

    expect(currentView().controller.groupBy).toBe("status");
    expect(screen.queryByTestId("project-hierarchy-host")).toBeNull();
  });

  it("keeps an explicit group=owner in the URL", () => {
    mocks.portableSurfaceEnabled = true;
    mocks.flagEnabled = false;
    mocks.realView = true;
    const mounted = mount("group=owner");
    expect(currentView().controller.groupBy).toBe("owner");

    mocks.flagEnabled = true;
    act(() => mounted.rerender());

    expect(currentView().controller.groupBy).toBe("owner");
    expect(screen.queryByTestId("project-hierarchy-host")).toBeNull();
  });
});
