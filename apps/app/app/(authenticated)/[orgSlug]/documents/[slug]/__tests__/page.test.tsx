import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ISS-12855: /documents/[slug] is the one detail page for every document. It
// does no server fetch: it parses `?version` (an invalid value falls back to
// the latest version on every type, PLN-2217 Q-002) and mounts the client
// container, which loads the document and picks the editor by its type.

const { resolveOgMetadata } = vi.hoisted(() => ({
  resolveOgMetadata: vi.fn(() => Promise.resolve({ title: "meta" })),
}));
vi.mock("@/lib/og-metadata", () => ({ resolveOgMetadata }));

// The client container is a leaf marker — the page test asserts what the page
// hands it, not the editor internals (those have their own coverage).
vi.mock("../document-editor-container", () => ({
  DocumentEditorContainer: ({
    slug,
    version,
  }: {
    slug: string;
    version?: number;
  }) => (
    <div
      data-slug={slug}
      data-testid="doc-editor"
      data-version={version ?? ""}
    />
  ),
}));

import DocumentPage, { generateMetadata } from "../page";

function makeParams(slug: string, version?: string) {
  return {
    params: Promise.resolve({ orgSlug: "acme", slug }),
    searchParams: Promise.resolve(version ? { version } : {}),
  };
}

describe("DocumentPage (/documents/[slug])", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("mounts the container for the slug at the latest version", async () => {
    render(await DocumentPage(makeParams("onboarding")));

    const editor = screen.getByTestId("doc-editor");
    expect(editor).toHaveAttribute("data-slug", "onboarding");
    expect(editor).toHaveAttribute("data-version", "");
  });

  it("passes a valid version through to the container", async () => {
    render(await DocumentPage(makeParams("onboarding", "3")));

    expect(screen.getByTestId("doc-editor")).toHaveAttribute(
      "data-version",
      "3"
    );
  });

  it.each([
    ["zero", "0"],
    ["non-numeric", "not-a-number"],
    ["trailing-garbage", "2junk"],
    ["past int4 max", "3000000000"],
    ["decimal", "2.5"],
  ])(
    "ignores a %s version param and falls back to the latest version",
    async (_label, version) => {
      render(await DocumentPage(makeParams("onboarding", version)));

      expect(screen.getByTestId("doc-editor")).toHaveAttribute(
        "data-version",
        ""
      );
    }
  );

  it("serves OG metadata for the document from /documents/<slug>", async () => {
    const metadata = await generateMetadata(makeParams("ISS-42"));

    expect(resolveOgMetadata).toHaveBeenCalledWith("acme/documents/ISS-42");
    expect(metadata).toEqual({ title: "meta" });
  });
});
