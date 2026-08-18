import { BranchProvenance } from "@repo/api/src/types/branch";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionProvenanceChip } from "../session-provenance-chip";

describe("SessionProvenanceChip (FEA-3575)", () => {
  it("labels a bot session", () => {
    render(<SessionProvenanceChip provenance={BranchProvenance.Bot} />);
    expect(screen.getByLabelText("Bot session")).toHaveTextContent("Bot");
  });

  it("labels an agent session", () => {
    render(<SessionProvenanceChip provenance={BranchProvenance.Agent} />);
    expect(screen.getByLabelText("Agent session")).toHaveTextContent("Agent");
  });

  it("renders nothing for human sessions", () => {
    const { container } = render(
      <SessionProvenanceChip provenance={BranchProvenance.Human} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for null/undefined provenance", () => {
    const { container } = render(<SessionProvenanceChip provenance={null} />);
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = render(
      <SessionProvenanceChip provenance={undefined} />
    );
    expect(c2).toBeEmptyDOMElement();
  });
});
