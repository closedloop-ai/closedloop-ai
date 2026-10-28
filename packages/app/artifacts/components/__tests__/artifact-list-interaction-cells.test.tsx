import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactListCell } from "../artifact-list-cells";

const document = createMockDocument();

describe("artifact interaction evidence cells", () => {
  it("renders authoritative people using provider-qualified identities", () => {
    render(
      <TooltipProvider>
        <ArtifactListCell
          collaborators={{
            availability: BranchIdentityAvailability.Complete,
            people: [
              {
                provider: BranchPersonProvider.ClosedLoop,
                id: "user-1",
                displayName: "Avery Example",
              },
            ],
            sources: {},
          }}
          columnId="collaborators"
          document={document}
          editHandlers={{}}
        />
      </TooltipProvider>
    );
    expect(
      screen.getByRole("img", { name: "Avery Example" })
    ).toBeInTheDocument();
  });
  it("keeps unavailable collaborator evidence distinct from computed empty", () => {
    const view = render(
      <ArtifactListCell
        columnId="collaborators"
        document={document}
        editHandlers={{}}
      />
    );
    expect(screen.getByTitle("Unavailable")).toBeInTheDocument();
    view.rerender(
      <ArtifactListCell
        collaborators={{
          availability: BranchIdentityAvailability.Unavailable,
          people: [],
          sources: {},
        }}
        columnId="collaborators"
        document={document}
        editHandlers={{}}
      />
    );
    expect(screen.getByTitle("Unavailable")).toBeInTheDocument();
  });
  it("renders the supplied combined count and distinguishes missing from zero", () => {
    const view = render(
      <ArtifactListCell
        columnId="comments"
        commentCount={3}
        document={document}
        editHandlers={{}}
      />
    );
    expect(screen.getByText("3 comments")).toBeInTheDocument();
    view.rerender(
      <ArtifactListCell
        columnId="comments"
        commentCount={0}
        document={document}
        editHandlers={{}}
      />
    );
    expect(screen.getByText("No comments")).toBeInTheDocument();
    view.rerender(
      <ArtifactListCell
        columnId="comments"
        document={document}
        editHandlers={{}}
      />
    );
    expect(screen.queryByText("No comments")).not.toBeInTheDocument();
  });
});
