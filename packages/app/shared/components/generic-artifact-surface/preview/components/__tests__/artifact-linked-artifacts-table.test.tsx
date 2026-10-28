import { render, screen, within } from "@testing-library/react";
import { FileIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  LinkedArtifactGroupsTable,
  type LinkedArtifactTableRow,
} from "../artifact-linked-artifacts-table";

const row = (
  key: string,
  relationship: string | null
): LinkedArtifactTableRow => ({
  key,
  href: null,
  icon: FileIcon,
  slug: key.toUpperCase(),
  name: `Fixture: ${key}`,
  relationship,
});

describe("LinkedArtifactGroupsTable", () => {
  it("draws no Relationship column for a group that opts out", () => {
    render(
      <LinkedArtifactGroupsTable
        groups={[
          {
            key: "sub-issues",
            heading: "Sub-issues",
            hideRelationship: true,
            rows: [row("iss-1", null), row("iss-2", null)],
          },
        ]}
      />
    );
    const group = screen.getByRole("region", { name: "Sub-issues" });
    expect(within(group).getByText("ISS-1")).toBeInTheDocument();
    expect(within(group).queryByText("Relationship")).not.toBeInTheDocument();
  });

  it("drops the heading row and region for a group its host titles", () => {
    render(
      <LinkedArtifactGroupsTable
        groups={[
          {
            key: "sub-issues",
            heading: "Sub-issues",
            hideHeading: true,
            hideRelationship: true,
            rows: [row("iss-1", null)],
          },
        ]}
      />
    );
    expect(screen.getByText("ISS-1")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("keeps the column for a group whose rows all state none, so groups line up", () => {
    // A Session's Branch group of pull requests without a linked branch has
    // only null relationships (sessionLinkedArtifactGroups); it must keep the
    // column so it lines up with the Documents group above it.
    render(
      <LinkedArtifactGroupsTable
        groups={[
          {
            key: "documents",
            heading: "Documents",
            rows: [row("prd-1", "Parent")],
          },
          {
            key: "branches",
            heading: "Branches",
            rows: [row("pr-1", null), row("pr-2", null)],
          },
        ]}
      />
    );
    const branches = screen.getByRole("region", { name: "Branches" });
    expect(within(branches).getByText("Relationship")).toBeInTheDocument();
  });

  it("keeps the column, blank cells included, when any row states one", () => {
    render(
      <LinkedArtifactGroupsTable
        groups={[
          {
            key: "documents",
            heading: "Documents",
            rows: [row("prd-1", "Parent"), row("pln-1", null)],
          },
        ]}
      />
    );
    const group = screen.getByRole("region", { name: "Documents" });
    expect(within(group).getByText("Relationship")).toBeInTheDocument();
    expect(within(group).getByText("Parent")).toBeInTheDocument();
  });
});
