import { Link } from "@repo/navigation/link";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactKind, genericArtifacts } from "../../fixtures";
import { EditableArtifactLead } from "../artifact-list-cells";

describe("artifact lead host link", () => {
  it("preserves Web hrefs and row open behavior", () => {
    const artifact = genericArtifacts.find(
      (item) => item.kind === ArtifactKind.Document
    );
    if (!artifact) {
      throw new Error("Document fixture missing");
    }
    const memory = createMemoryNavigation({ orgSlug: "acme" });
    const onOpen = vi.fn();
    render(
      <NavigationProvider adapter={memory.adapter}>
        <EditableArtifactLead
          artifact={artifact}
          linkComponent={Link}
          onCommit={vi.fn()}
          onOpenArtifact={onOpen}
          openHref="/acme/documents/DOC-184"
        />
      </NavigationProvider>
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "/acme/documents/DOC-184"
    );
    fireEvent.click(screen.getByRole("link"));
    expect(onOpen).toHaveBeenCalledWith(artifact);
  });
});
