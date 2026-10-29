import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectsTable } from "../projects-table";

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

/**
 * The table receives already-filtered rows, so an empty result has two very
 * different causes and only the caller knows which. "No projects yet — Projects
 * will appear here after they are added to this team" is a statement about the
 * TEAM; rendering it after a user narrows a filter to nothing tells them the
 * wrong thing about their own data.
 *
 * ISS-10476 moved this component out of `apps/prototypes` into `@repo/app`; the
 * contract moved with it, so its coverage did too.
 */
describe("ProjectsTable empty state", () => {
  it("speaks about the team when nothing is filtered", () => {
    render(<ProjectsTable rows={[]} />);

    expect(screen.getByText("No projects yet")).toBeTruthy();
  });

  it("speaks about the filters when the caller narrowed the rows", () => {
    render(<ProjectsTable filtersActive rows={[]} />);

    expect(screen.getByText("No projects match these filters")).toBeTruthy();
    expect(screen.queryByText("No projects yet")).toBeNull();
  });
});
