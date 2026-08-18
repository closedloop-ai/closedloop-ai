/**
 * FEA-4098 (Slice 3): CollaboratorStack renders the authors people-set
 * (discoverer + editors) that replaced the single Owner cell.
 *
 * Covers:
 *  - empty authors set → honest em dash (never a silent blank / lying UI)
 *  - a populated set → an accessible group labelled with the author names,
 *    with the decorative initials chips hidden from assistive tech
 *  - overflow → a `+N` chip beyond `max`, still inside the labelled group
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CollaboratorStack } from "../component-meta";

describe("CollaboratorStack", () => {
  it("renders an em dash when there are no authors (honest empty state)", () => {
    render(<CollaboratorStack users={[]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    // No avatar group is rendered for the empty case.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("exposes the author names as the group's accessible name", () => {
    render(<CollaboratorStack users={["Dana Discoverer", "Edith Editor"]} />);
    const group = screen.getByRole("img");
    expect(group).toHaveAccessibleName("Dana Discoverer, Edith Editor");
  });

  it("shows a +N overflow chip beyond `max`, inside the labelled group", () => {
    const users = ["A One", "B Two", "C Three", "D Four", "E Five"];
    render(<CollaboratorStack max={4} users={users} />);
    // The accessible name lists EVERY author, not just the shown avatars.
    expect(screen.getByRole("img")).toHaveAccessibleName(users.join(", "));
    // 5 authors, max 4 shown → a "+1" overflow chip.
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  // FEA-4247: with the owner fallback a single author is the common case; the
  // detail panel opts into plain-text so the name is readable, not hidden behind
  // an initials-circle hover.
  it("renders a single author as plain text when singleAsText is set (name is directly visible)", () => {
    render(<CollaboratorStack singleAsText users={["Ada Lovelace"]} />);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    // No avatar group — the lone name is plain text, not a hover-only title.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps the avatar stack for 2+ authors even with singleAsText set", () => {
    render(
      <CollaboratorStack
        singleAsText
        users={["Dana Discoverer", "Edith Editor"]}
      />
    );
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "Dana Discoverer, Edith Editor"
    );
  });

  // Without the opt-in the compact table column keeps the avatar for a lone
  // author (unchanged presentation).
  it("keeps the avatar for a single author when singleAsText is not set", () => {
    render(<CollaboratorStack users={["Ada Lovelace"]} />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Ada Lovelace");
  });
});
