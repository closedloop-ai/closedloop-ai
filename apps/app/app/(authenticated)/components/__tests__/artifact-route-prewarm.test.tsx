import { DOC_SYNC_EDITOR_FLAG_KEY } from "@repo/api/src/types/doc-sync-editor-flag";
import { DocumentType } from "@repo/api/src/types/document";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { useDocumentBySlug } from "@repo/app/documents/hooks/use-documents";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactRoutePrewarm } from "../artifact-route-prewarm";

const apiGet = vi.fn();
const useCurrentUserMock = vi.fn();
const useAuthMock = vi.fn();
const prewarmRoom = vi.fn();
let pathname = "/";
let search = "";

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: apiGet }),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => useCurrentUserMock(),
}));

vi.mock("@repo/auth/client", () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => pathname,
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(search),
}));

const enabledFlags = new Set<string>();
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => enabledFlags.has(key),
}));

vi.mock("@repo/collaboration/client/use-prewarm-document-room", () => ({
  usePrewarmDocumentRoom: (roomId: string | null) => prewarmRoom(roomId),
}));

// The document's org differs from the viewer's on purpose: the room must be
// built from the document the editor will open, never from anything else.
const RESOLVED_DOCUMENT = {
  id: "doc-1",
  slug: "ISS-12",
  organizationId: "org-doc",
  type: DocumentType.Feature,
};
const SIGNED_IN_USER = { id: "user-1", organizationId: "org-viewer" };
const RESOLVED_IDENTITY = {
  isLoaded: true,
  userId: "user_clerk_1",
  orgId: "org_clerk_1",
  orgSlug: "acme",
};

function PageReader({ slug }: { slug: string }) {
  const { data } = useDocumentBySlug(slug);
  return <span data-testid="page-document">{data?.id ?? "loading"}</span>;
}

// The shared factory, not a bare QueryClient: its freshness window is what lets
// the page find the warmed document instead of refetching it.
let client: QueryClient;

function withClient(children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function lastRoomId(): string | null | undefined {
  return prewarmRoom.mock.calls.at(-1)?.[0];
}

describe("ArtifactRoutePrewarm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enabledFlags.clear();
    client = makeQueryClient();
    pathname = "/acme/documents/ISS-12";
    search = "";
    apiGet.mockResolvedValue(RESOLVED_DOCUMENT);
    useCurrentUserMock.mockReturnValue({
      data: SIGNED_IN_USER,
      isLoading: false,
    });
    useAuthMock.mockReturnValue(RESOLVED_IDENTITY);
  });

  it("reads the page's document early, and the page reuses that read", async () => {
    const { rerender, findByTestId } = render(
      withClient(<ArtifactRoutePrewarm />)
    );
    await waitFor(() => expect(lastRoomId()).not.toBeNull());
    expect(apiGet).toHaveBeenCalledWith("/documents/by-slug/ISS-12");

    rerender(
      withClient(
        <>
          <ArtifactRoutePrewarm />
          <PageReader slug="ISS-12" />
        </>
      )
    );

    expect((await findByTestId("page-document")).textContent).toBe("doc-1");
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  // PLN-2189 T-3.6: the doc-sync editor loads no Liveblocks Y.Doc to warm.
  it("warms no Liveblocks room when the doc-sync editor is on", async () => {
    enabledFlags.add(DOC_SYNC_EDITOR_FLAG_KEY);

    const { findByTestId } = render(
      withClient(
        <>
          <ArtifactRoutePrewarm />
          <PageReader slug="ISS-12" />
        </>
      )
    );

    // The document has resolved, which is when the flag-off path joins a room.
    const pageDocument = await findByTestId("page-document");
    await waitFor(() => expect(pageDocument.textContent).toBe("doc-1"));
    expect(apiGet).toHaveBeenCalledWith("/documents/by-slug/ISS-12");
    expect(prewarmRoom).toHaveBeenCalled();
    expect(prewarmRoom.mock.calls.every(([roomId]) => roomId === null)).toBe(
      true
    );
  });

  it("joins the room built from the resolved document, not the URL", async () => {
    // A legacy `FEA-*` slug still resolves, and is only the lookup key: the
    // editor joins the room of the document the lookup returns, whose slug and
    // organization both differ from the URL's.
    pathname = "/acme/documents/FEA-12";

    render(withClient(<ArtifactRoutePrewarm />));

    await waitFor(() =>
      expect(lastRoomId()).toBe(generateDocumentRoomId("org-doc", "ISS-12"))
    );
    expect(apiGet).toHaveBeenCalledWith("/documents/by-slug/FEA-12");
  });

  it("joins no room for a Template, whose page renders not-found", async () => {
    pathname = "/acme/documents/TPL-3";
    apiGet.mockResolvedValue({
      ...RESOLVED_DOCUMENT,
      slug: "TPL-3",
      type: DocumentType.Template,
    });

    render(withClient(<ArtifactRoutePrewarm />));

    await waitFor(() =>
      expect(client.getQueryData(documentKeys.bySlug("TPL-3"))).toMatchObject({
        type: DocumentType.Template,
      })
    );
    expect(prewarmRoom.mock.calls.every(([roomId]) => roomId === null)).toBe(
      true
    );
  });

  it("joins no room before the signed-in user resolves", async () => {
    useCurrentUserMock.mockReturnValue({ data: undefined, isLoading: true });

    render(withClient(<ArtifactRoutePrewarm />));

    // The document read still went out, so the null below is the user gate
    // holding, not a component that never got as far as a room.
    await waitFor(() =>
      expect(client.getQueryData(documentKeys.bySlug("ISS-12"))).toEqual(
        RESOLVED_DOCUMENT
      )
    );
    expect(prewarmRoom.mock.calls.every(([roomId]) => roomId === null)).toBe(
      true
    );
  });

  it("reads nothing until the identity the cache is scoped by resolves", async () => {
    // Issued earlier than that, the read hashes under the anonymous scope
    // (ISS-7442) and the page's read misses it — a second request, not an
    // earlier one.
    useAuthMock.mockReturnValue({ isLoaded: false, userId: null, orgId: null });

    const { rerender } = render(withClient(<ArtifactRoutePrewarm />));

    expect(apiGet).not.toHaveBeenCalled();
    expect(lastRoomId()).toBeNull();

    useAuthMock.mockReturnValue(RESOLVED_IDENTITY);
    rerender(withClient(<ArtifactRoutePrewarm />));

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith("/documents/by-slug/ISS-12")
    );
  });

  it.each([
    ["a list route", "/acme/issues", ""],
    ["a historical version", "/acme/documents/ISS-12", "version=2"],
    // Before `OrgIdentityProvider` switches orgs, the slug would resolve in the
    // active org and warm that org's same-numbered document and room.
    ["a link into another org", "/other-org/documents/ISS-12", ""],
  ])("reads nothing and joins nothing on %s", (_label, path, query) => {
    pathname = path;
    search = query;

    render(withClient(<ArtifactRoutePrewarm />));

    expect(apiGet).not.toHaveBeenCalled();
    expect(prewarmRoom).toHaveBeenCalled();
    expect(prewarmRoom.mock.calls.every(([roomId]) => roomId === null)).toBe(
      true
    );
  });
});
