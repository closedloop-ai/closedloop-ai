import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { useDocumentBySlug } from "@repo/app/documents/hooks/use-documents";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
} from "@repo/app/shared/api/api-timeout";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ErrorBoundary,
  type ErrorComponent,
} from "next/dist/client/components/error-boundary";
import { HTTPAccessFallbackBoundary } from "next/dist/client/components/http-access-fallback/error-boundary";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuthenticatedErrorBoundary from "../../../error";
import { DocumentEditorContainer } from "../../documents/[slug]/document-editor-container";

// ISS-12080: drives the real route containers through the real
// `useDocumentBySlug` query, under Next's real segment boundaries in their
// layout-router order: `ErrorBoundary` holding the real `(authenticated)/error.tsx`,
// then the not-found boundary. Only the network (`useApiClient`) and the heavy
// editors are stubbed. `notFound` is the real one, spied, so it is routed to the
// not-found boundary and never to `error.tsx`, exactly as in production.

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get }),
}));

const { notFound } = vi.hoisted(() => ({ notFound: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  notFound.mockImplementation(actual.notFound);
  return { ...actual, notFound };
});

vi.mock("@/lib/datadog-rum/report-error", () => ({
  reportNextjsError: vi.fn(),
}));

vi.mock("../../documents/[slug]/document-editor", () => ({
  DocumentEditor: (props: EditorLeafProps) => <EditorLeaf {...props} />,
}));

const SLUG = "ISS-11901";

const DOCUMENT = {
  id: "doc-1",
  slug: SLUG,
  type: DocumentType.Feature,
  latestVersion: 4,
  version: { version: 4, content: "body" },
} as unknown as DocumentDetail;

const ROUTES: ReadonlyArray<{
  route: string;
  Container: ComponentType<{ slug: string }>;
}> = [{ route: "documents", Container: DocumentEditorContainer }];

const NON_404_FAILURES: ReadonlyArray<{ kind: string; error: ApiError }> = [
  {
    kind: "network",
    error: new ApiError("Failed to fetch", API_NO_RESPONSE_STATUS),
  },
  {
    kind: "timeout",
    error: new ApiError("Request timed out", API_NO_RESPONSE_STATUS, {
      code: API_TIMEOUT_ERROR_CODE,
    }),
  },
  { kind: "5xx", error: new ApiError("Internal Server Error", 500) },
  { kind: "401", error: new ApiError("Unauthorized", 401) },
];

afterEach(() => {
  vi.clearAllMocks();
});

describe("VersionedDocumentEditorContainer query failures (ISS-12080)", () => {
  it.each(ROUTES)(
    "/$route keeps the loaded artifact when a background refetch fails",
    async ({ Container }) => {
      get
        .mockResolvedValueOnce(DOCUMENT)
        .mockRejectedValueOnce(
          new ApiError("Failed to fetch", API_NO_RESPONSE_STATUS)
        );
      const queryClient = renderRoute(
        <Container slug={SLUG} />,
        <QueryProbe />
      );
      expect(await screen.findByTestId("artifact-editor")).toBeInTheDocument();

      await act(() => queryClient.refetchQueries());
      await screen.findByTestId("query-error-delivered");

      expect(queryClient.getQueryState(documentKeys.bySlug(SLUG))).toEqual(
        expect.objectContaining({ status: "error", data: DOCUMENT })
      );
      expect(screen.getByTestId("artifact-editor")).toBeInTheDocument();
      expect(notFound).not.toHaveBeenCalled();
    }
  );

  it.each(NON_404_FAILURES)(
    "keeps the loaded artifact when a background refetch fails with $kind",
    async ({ error }) => {
      get.mockResolvedValueOnce(DOCUMENT).mockRejectedValueOnce(error);
      const queryClient = renderRoute(
        <DocumentEditorContainer slug={SLUG} />,
        <QueryProbe />
      );
      await screen.findByTestId("artifact-editor");

      await act(() => queryClient.refetchQueries());
      await screen.findByTestId("query-error-delivered");

      expect(screen.getByTestId("artifact-editor")).toBeInTheDocument();
      expect(notFound).not.toHaveBeenCalled();
    }
  );

  // Perrin Upcott, 2026-10-06 (ISS-12080 ruling 1): "Refetch 404 → not-found".
  it("renders the not-found screen when a background refetch answers 404", async () => {
    get
      .mockResolvedValueOnce(DOCUMENT)
      .mockRejectedValueOnce(new ApiError("Not Found", 404));
    const queryClient = renderRoute(<DocumentEditorContainer slug={SLUG} />);
    await screen.findByTestId("artifact-editor");

    await act(() => queryClient.refetchQueries());

    expect(await screen.findByTestId("not-found-boundary")).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-editor")).not.toBeInTheDocument();
    expect(notFound).toHaveBeenCalled();
  });

  it("renders the not-found screen for a first-load API 404", async () => {
    get.mockRejectedValueOnce(new ApiError("Not Found", 404));
    renderRoute(<DocumentEditorContainer slug={SLUG} />);

    expect(await screen.findByTestId("not-found-boundary")).toBeInTheDocument();
    expect(notFound).toHaveBeenCalled();
  });

  it("renders the not-found screen for a first-load 404 of a version that does not exist", async () => {
    get.mockRejectedValueOnce(new ApiError("Not Found", 404));
    renderRoute(<DocumentEditorContainer slug={SLUG} version={99} />);

    expect(await screen.findByTestId("not-found-boundary")).toBeInTheDocument();
    expect(get.mock.calls).toEqual([[`${BY_SLUG_PATH}?version=99`]]);
  });

  it.each(NON_404_FAILURES)(
    "sends a first-load $kind failure to the error boundary, not not-found",
    async ({ error }) => {
      get.mockRejectedValueOnce(error);
      renderRoute(<DocumentEditorContainer slug={SLUG} />);

      expect(
        await screen.findByRole("heading", { name: "Something went wrong" })
      ).toBeVisible();
      expect(notFound).not.toHaveBeenCalled();
    }
  );

  it("restores the artifact when Try again refetches after a first-load failure", async () => {
    get
      .mockRejectedValueOnce(
        new ApiError("Failed to fetch", API_NO_RESPONSE_STATUS)
      )
      .mockResolvedValueOnce(DOCUMENT);
    renderRoute(<DocumentEditorContainer slug={SLUG} />);
    await screen.findByRole("heading", { name: "Something went wrong" });

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("artifact-editor")).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

// Perrin Upcott, 2026-10-06 (ISS-12080 ruling 2): a picked version that fails
// to load keeps the displayed version, and the container's version state with it.
// A 404 is no exception ("Keep current version").
describe("VersionedDocumentEditorContainer version switch (ISS-12080)", () => {
  it("keeps the displayed version when the picked version fails to load", async () => {
    get.mockImplementation((path: string) =>
      path === `${BY_SLUG_PATH}?version=2`
        ? Promise.reject(new ApiError("Internal Server Error", 500))
        : Promise.resolve(DOCUMENT)
    );
    const queryClient = renderRoute(
      <DocumentEditorContainer slug={SLUG} />,
      <QueryProbe version={2} />
    );
    await screen.findByTestId("artifact-editor");

    await userEvent.click(screen.getByRole("button", { name: "v2" }));
    await screen.findByTestId("query-error-delivered");

    expect(screen.getByTestId("artifact-editor")).toHaveAttribute(
      "data-version",
      "4"
    );
    expect(
      screen.queryByRole("heading", { name: "Something went wrong" })
    ).not.toBeInTheDocument();

    // The container still observes the displayed version: a refetch asks for
    // it, not for the version that failed.
    get.mockClear();
    await act(() => queryClient.refetchQueries({ type: "active" }));
    expect(get.mock.calls).toEqual([[BY_SLUG_PATH]]);
  });

  // Perrin Upcott, 2026-10-06 (ISS-12080, "Keep current version").
  it("keeps the displayed version when the picked version answers 404", async () => {
    get.mockImplementation((path: string) =>
      path === `${BY_SLUG_PATH}?version=2`
        ? Promise.reject(new ApiError("Not Found", 404))
        : Promise.resolve(DOCUMENT)
    );
    renderRoute(
      <DocumentEditorContainer slug={SLUG} />,
      <QueryProbe version={2} />
    );
    await screen.findByTestId("artifact-editor");

    await userEvent.click(screen.getByRole("button", { name: "v2" }));
    await screen.findByTestId("query-error-delivered");

    expect(screen.getByTestId("artifact-editor")).toHaveAttribute(
      "data-version",
      "4"
    );
    expect(screen.queryByTestId("not-found-boundary")).not.toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("shows the last picked version when an earlier pick resolves after it", async () => {
    let resolveVersion2: (document: DocumentDetail) => void = () => undefined;
    get.mockImplementation((path: string) => {
      if (path === `${BY_SLUG_PATH}?version=2`) {
        return new Promise((resolve) => {
          resolveVersion2 = resolve;
        });
      }
      if (path === `${BY_SLUG_PATH}?version=3`) {
        return Promise.resolve(documentAtVersion(3));
      }
      return Promise.resolve(DOCUMENT);
    });
    renderRoute(
      <DocumentEditorContainer slug={SLUG} />,
      <QueryProbe version={2} />
    );
    await screen.findByTestId("artifact-editor");

    await userEvent.click(screen.getByRole("button", { name: "v2" }));
    await userEvent.click(screen.getByRole("button", { name: "v3" }));
    await waitFor(() =>
      expect(screen.getByTestId("artifact-editor")).toHaveAttribute(
        "data-version",
        "3"
      )
    );

    act(() => resolveVersion2(documentAtVersion(2)));
    await screen.findByTestId("query-data-delivered");

    expect(screen.getByTestId("artifact-editor")).toHaveAttribute(
      "data-version",
      "3"
    );
  });
});

const BY_SLUG_PATH = `/documents/by-slug/${SLUG}`;

type EditorLeafProps = {
  currentVersion: number;
  document: DocumentDetail;
  onVersionChange: (version: number) => void;
};

function EditorLeaf({
  currentVersion,
  document,
  onVersionChange,
}: EditorLeafProps) {
  return (
    <div
      data-doc-id={document.id}
      data-testid="artifact-editor"
      data-version={currentVersion}
    >
      {[2, 3].map((version) => (
        <button
          key={version}
          onClick={() => onVersionChange(version)}
          type="button"
        >
          v{version}
        </button>
      ))}
    </div>
  );
}

function documentAtVersion(version: number): DocumentDetail {
  return { ...DOCUMENT, version: { ...DOCUMENT.version, version } };
}

// React Query delivers a settled fetch to observers on a later tick than the
// fetch promise settles, after every callback chained on that promise. This
// disabled sibling observer of the same query renders in that delivery, so
// waiting for it proves the container has already handled the result.
function QueryProbe({ version }: { version?: number }) {
  const { data, error } = useDocumentBySlug(SLUG, version, { enabled: false });
  if (error) {
    return <div data-testid="query-error-delivered" />;
  }
  return data ? <div data-testid="query-data-delivered" /> : null;
}

const authenticatedErrorComponent: ErrorComponent = AuthenticatedErrorBoundary;

function renderRoute(ui: ReactNode, outsideBoundaries?: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      {outsideBoundaries}
      <ErrorBoundary errorComponent={authenticatedErrorComponent}>
        <HTTPAccessFallbackBoundary
          notFound={<div data-testid="not-found-boundary" />}
        >
          {ui}
        </HTTPAccessFallbackBoundary>
      </ErrorBoundary>
    </QueryClientProvider>
  );
  return queryClient;
}
