import {
  type BranchCollaborators,
  BranchIdentityAvailability,
} from "@repo/api/src/types/branch-identity";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchShellCollaborators } from "../branch-shell-collaborators";

const STATUS_WORDS = /unavailable|incomplete/i;

const { readCollaborators } = vi.hoisted(() => ({
  readCollaborators: vi.fn(),
}));

vi.mock("../../hooks/use-branch-shell-collaborators", () => ({
  useBranchShellCollaborators: (branchId: string) =>
    readCollaborators(branchId),
}));

function read(
  availability: BranchIdentityAvailability,
  names: string[],
  isPending = false
) {
  return {
    isPending,
    collaborators: {
      availability,
      people: names.map((displayName) => ({
        id: `id-${displayName}`,
        displayName,
        login: displayName.toLowerCase(),
      })),
    } as BranchCollaborators,
  };
}

describe("BranchShellCollaborators", () => {
  beforeEach(() => {
    readCollaborators.mockReset();
  });

  it("renders the shared widget for the branch's people", () => {
    readCollaborators.mockReturnValue(
      read(BranchIdentityAvailability.Complete, ["Ada", "Grace"])
    );
    const { container } = render(<BranchShellCollaborators branchId="b-1" />);

    expect(readCollaborators).toHaveBeenCalledWith("b-1");
    expect(screen.getByRole("img", { name: "Ada, Grace" })).toBeInTheDocument();
    expect(container).not.toHaveTextContent(STATUS_WORDS);
  });

  it("renders nothing while the read is pending, even though the placeholder says unavailable", () => {
    readCollaborators.mockReturnValue(
      read(BranchIdentityAvailability.Unavailable, [], true)
    );
    const { container } = render(<BranchShellCollaborators branchId="b-1" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows people without any note for a partial list", () => {
    readCollaborators.mockReturnValue(
      read(BranchIdentityAvailability.Incomplete, ["Ada"])
    );
    const { container } = render(<BranchShellCollaborators branchId="b-1" />);

    expect(screen.getByRole("img", { name: "Ada" })).toBeInTheDocument();
    expect(container).not.toHaveTextContent(STATUS_WORDS);
  });

  it("shows no word for an unavailable read once it has settled", () => {
    readCollaborators.mockReturnValue(
      read(BranchIdentityAvailability.Unavailable, [])
    );
    const { container } = render(<BranchShellCollaborators branchId="b-1" />);

    expect(container).not.toHaveTextContent(STATUS_WORDS);
  });
});
