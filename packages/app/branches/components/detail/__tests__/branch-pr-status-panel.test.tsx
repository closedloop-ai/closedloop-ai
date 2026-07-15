import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import { BranchPrStatusPanel } from "../branch-pr-status-panel";

const MULTI_PR_RE = /multiple prs are linked/i;
const CONNECT_RE = /light up this metric/i;
const CONNECT_COPY_RE = /connect github to see live review/i;
const SECTION_TITLE = "Checks & review";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function mockReviews(response: Response) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() => Promise.resolve(response));
}

function renderPanel(detail: BranchPageDetail): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <BranchPrStatusPanel detail={detail} />
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BranchPrStatusPanel", () => {
  it("renders nothing when no PR is linked", () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: null,
    });
    render(renderPanel(detail));
    expect(screen.queryByText(SECTION_TITLE)).not.toBeInTheDocument();
  });

  it("lights up the lifecycle badge + approvals from live review data when connected", async () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 42,
      status: "open",
    });
    mockReviews(
      jsonResponse(200, {
        reviewDecision: "APPROVED",
        approvalCount: 2,
        changesRequestedCount: 0,
      })
    );

    render(renderPanel(detail));

    await waitFor(() =>
      expect(screen.getByText("2 approvals")).toBeInTheDocument()
    );
    // Badge refines to "Approved" on a live APPROVED decision.
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });

  it("uses the linked PR URL for live status when branch repo identity is missing", async () => {
    const detail = makeBranchDetail({
      repoFullName: null,
      prUrl: "https://github.com/octo/repo/pull/42",
      prNumber: 42,
      status: "open",
    });
    const fetchSpy = mockReviews(
      jsonResponse(200, {
        reviewDecision: "APPROVED",
        approvalCount: 1,
        changesRequestedCount: 0,
      })
    );

    render(renderPanel(detail));

    await waitFor(() =>
      expect(screen.getByText("1 approval")).toBeInTheDocument()
    );
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("owner=octo");
    expect(url).toContain("repo=repo");
    expect(url).toContain("number=42");
  });

  it("gates with a multi-PR notice (no connect CTA) when multiple PRs are linked", () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 42,
      multiPrWarning: true,
      status: "open",
    });
    const fetchSpy = mockReviews(jsonResponse(200, {}));

    render(renderPanel(detail));

    expect(screen.getByText(MULTI_PR_RE)).toBeInTheDocument();
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
    // Ambiguous attribution → the overlay is never queried.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("degrades to a connect-GitHub affordance (no thrown error) on a gateway 403", async () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 9,
      status: "open",
    });
    mockReviews(jsonResponse(403, { error: "nope" }));

    render(renderPanel(detail));

    await waitFor(() =>
      expect(screen.getByText(CONNECT_COPY_RE)).toBeInTheDocument()
    );
    expect(screen.getByText(CONNECT_RE)).toBeInTheDocument();
  });

  it("still renders PERSISTED checks when live is unavailable (403)", async () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 9,
      status: "open",
      // Persisted enrichment present (forward-compat; null in v1).
      checksStatus: "PASSING",
      checksPassed: 3,
      checksTotal: 3,
    });
    mockReviews(jsonResponse(403, { error: "nope" }));

    render(renderPanel(detail));

    await waitFor(() =>
      expect(screen.getByText(CONNECT_COPY_RE)).toBeInTheDocument()
    );
    // Persisted checks shown alongside the connect affordance, not hidden.
    expect(screen.getByText("3/3 passing")).toBeInTheDocument();
    expect(screen.getByText(CONNECT_RE)).toBeInTheDocument();
  });

  it("does NOT show the previous branch's status after navigating to a no-PR branch", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockReviews(
      jsonResponse(200, {
        reviewDecision: "APPROVED",
        approvalCount: 2,
        changesRequestedCount: 0,
      })
    );

    const withPr = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 42,
      status: "open",
    });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <BranchPrStatusPanel detail={withPr} />
      </QueryClientProvider>
    );
    await waitFor(() =>
      expect(screen.getByText("2 approvals")).toBeInTheDocument()
    );

    // Navigate to a branch with no PR — the panel renders nothing, never the
    // previous branch's approvals.
    const noPr = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: null,
    });
    rerender(
      <QueryClientProvider client={client}>
        <BranchPrStatusPanel detail={noPr} />
      </QueryClientProvider>
    );

    expect(screen.queryByText("2 approvals")).not.toBeInTheDocument();
    expect(screen.queryByText(SECTION_TITLE)).not.toBeInTheDocument();
  });
});
