// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactKind, genericArtifacts } from "../../fixtures";
import { CommonArtifactDetails } from "../artifact-detail-sections";

describe("artifact Details responsive content", () => {
  it("keeps read-only status, linked records, and version columns in mobile rows", () => {
    const session = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Session
    );
    expect(session).toBeDefined();
    render(
      <CommonArtifactDetails artifact={{ ...session!, currentVersion: "3" }} />
    );

    const status = screen
      .getByText("Set automatically, so it cannot be changed here.")
      .closest("fieldset");
    expect(status).toHaveClass("max-md:w-full", "max-md:flex-col");

    const linked = screen
      .getByRole("heading", { name: "Linked artifacts" })
      .closest("section");
    expect(linked).not.toBeNull();
    const linkedHeader = linked?.querySelector(".grid");
    expect(linkedHeader).toHaveClass("grid-cols-2");
    expect(linkedHeader?.firstElementChild).toHaveClass("col-span-2");
    const linkedRows = within(linked!).getAllByRole("button");
    expect(linkedRows).toHaveLength(3);
    for (const row of linkedRows) {
      expect(row).toHaveClass("grid-cols-2");
      expect(row.firstElementChild).toHaveClass("col-span-2");
    }

    const history = screen
      .getByRole("heading", { name: "Version history" })
      .closest("section");
    expect(history).not.toBeNull();
    const historyGrid = history?.querySelector(".grid");
    expect(historyGrid).toHaveClass("grid-cols-2");
    expect(historyGrid?.children).toHaveLength(4);
    const versionRows = history?.querySelectorAll("button[aria-pressed]");
    expect(versionRows).toHaveLength(3);
    expect(versionRows?.[0]).toHaveTextContent("Ottilie Eastwick");
    expect(versionRows?.[2]).toHaveTextContent("Pascoe Birchall");
    for (const row of versionRows ?? []) {
      expect(row).toHaveClass("grid-cols-2");
      expect(row.children).toHaveLength(4);
    }
  });

  it("shows only the current version for a one-version session", () => {
    const session = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Session
    );
    expect(session?.currentVersion).toBe("1");
    render(<CommonArtifactDetails artifact={session!} />);

    const history = screen
      .getByRole("heading", { name: "Version history" })
      .closest("section");
    expect(history).not.toBeNull();
    const rows = history?.querySelectorAll("button[aria-pressed]");
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toHaveTextContent("1Ottilie EastwickCurrent");
    expect(
      screen.queryByText(
        "The earlier interaction contract is ready to compare.",
        {
          exact: false,
        }
      )
    ).not.toBeInTheDocument();
  });
});
