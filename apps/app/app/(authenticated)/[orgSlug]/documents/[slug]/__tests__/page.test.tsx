import { DocumentType } from "@repo/api/src/types/document";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ISS-4382: /documents/[slug] serves two roles — it renders the DOC editor for
// a DOC-subtype artifact, and redirects a non-DOC slug to that type's own
// detail route (the pre-existing Liveblocks inbox-URL fallback). These tests
// drive the real async server component and assert both branches.
//
// notFound()/redirect() are hoisted so the next/navigation mock factory can
// close over initialized values; each throws a sentinel so a wrong branch
// surfaces as a thrown error rather than a silent pass.
const { notFound, redirect } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((_dest: string) => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/navigation", () => ({ notFound, redirect }));

const { getToken } = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("@repo/auth/server", () => ({
  auth: () => Promise.resolve({ getToken }),
}));

vi.mock("@/lib/api-origin", () => ({
  resolveApiOrigin: () => "http://api",
}));

// The client container is a leaf marker — the page test asserts the routing
// decision, not the editor internals (those have their own coverage) and needs
// no query/data providers.
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

import DocumentPage from "../page";

const RE_STATUS_500 = /status 500/;

function mockFetchArtifact(artifact: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve({ success: true, data: artifact }),
      })
    )
  );
}

function makeParams(slug: string, version?: string) {
  return {
    params: Promise.resolve({ orgSlug: "acme", slug }),
    searchParams: Promise.resolve(version ? { version } : {}),
  };
}

describe("DocumentPage (/documents/[slug])", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    getToken.mockReset();
  });

  it("renders the DOC editor for a DOC-subtype artifact", async () => {
    getToken.mockResolvedValue("tok");
    mockFetchArtifact({ type: DocumentType.Doc, slug: "onboarding" });

    render(await DocumentPage(makeParams("onboarding")));

    const editor = screen.getByTestId("doc-editor");
    expect(editor).toHaveAttribute("data-slug", "onboarding");
    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("passes a valid version through to the DOC editor", async () => {
    getToken.mockResolvedValue("tok");
    mockFetchArtifact({ type: DocumentType.Doc, slug: "onboarding" });

    render(await DocumentPage(makeParams("onboarding", "3")));

    expect(screen.getByTestId("doc-editor")).toHaveAttribute(
      "data-version",
      "3"
    );
  });

  it("ignores an invalid version param for a DOC and falls back to the latest version", async () => {
    getToken.mockResolvedValue("tok");
    mockFetchArtifact({ type: DocumentType.Doc, slug: "onboarding" });

    // A junk `?version` on a document that genuinely exists must render the
    // editor (latest version), not 404 as if the document were missing.
    render(await DocumentPage(makeParams("onboarding", "0")));

    const editor = screen.getByTestId("doc-editor");
    expect(editor).toHaveAttribute("data-slug", "onboarding");
    expect(editor).toHaveAttribute("data-version", "");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("ignores a non-numeric version param for a DOC and falls back to the latest version", async () => {
    getToken.mockResolvedValue("tok");
    mockFetchArtifact({ type: DocumentType.Doc, slug: "onboarding" });

    render(await DocumentPage(makeParams("onboarding", "not-a-number")));

    expect(screen.getByTestId("doc-editor")).toHaveAttribute(
      "data-version",
      ""
    );
    expect(notFound).not.toHaveBeenCalled();
  });

  it("redirects a non-DOC artifact to its type-specific detail route", async () => {
    getToken.mockResolvedValue("tok");
    mockFetchArtifact({ type: DocumentType.Prd, slug: "checkout" });

    await expect(DocumentPage(makeParams("checkout"))).rejects.toThrow(
      "NEXT_REDIRECT"
    );
    expect(redirect).toHaveBeenCalledWith("/acme/prds/checkout");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("404s when the API returns a genuine 404 for the slug", async () => {
    getToken.mockResolvedValue("tok");
    mockFetchArtifact(null, 404);

    await expect(DocumentPage(makeParams("ghost"))).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("propagates a transient backend failure to the error boundary instead of 404ing", async () => {
    getToken.mockResolvedValue("tok");
    // A 500 is a transient failure, not a missing document — it must throw so the
    // route error boundary renders, rather than lying with a permanent 404.
    mockFetchArtifact(null, 500);

    await expect(DocumentPage(makeParams("onboarding"))).rejects.toThrow(
      RE_STATUS_500
    );
    expect(notFound).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("ignores a trailing-garbage version param and falls back to the latest version", async () => {
    getToken.mockResolvedValue("tok");
    mockFetchArtifact({ type: DocumentType.Doc, slug: "onboarding" });

    // parseInt would read "2junk" as 2; strict validation rejects it.
    render(await DocumentPage(makeParams("onboarding", "2junk")));

    expect(screen.getByTestId("doc-editor")).toHaveAttribute(
      "data-version",
      ""
    );
    expect(notFound).not.toHaveBeenCalled();
  });

  it("ignores a decimal version param and falls back to the latest version", async () => {
    getToken.mockResolvedValue("tok");
    mockFetchArtifact({ type: DocumentType.Doc, slug: "onboarding" });

    render(await DocumentPage(makeParams("onboarding", "2.5")));

    expect(screen.getByTestId("doc-editor")).toHaveAttribute(
      "data-version",
      ""
    );
    expect(notFound).not.toHaveBeenCalled();
  });
});
