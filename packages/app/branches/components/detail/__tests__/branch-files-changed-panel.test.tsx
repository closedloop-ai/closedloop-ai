import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import { BranchFilesChangedPanel } from "../branch-files-changed-panel";

const NO_FILES_RE = /changed no files/i;
const NO_PR_RE = /changed files appear here once a pull request is opened/i;
const MULTI_PR_RE = /multiple pull requests are linked/i;
const UNAVAILABLE_RE = /connect github to list the files changed/i;
const CONNECT_RE = /light up this metric/i;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function mockFiles(response: () => Response) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() => Promise.resolve(response()));
}

function renderPanel(detail: BranchPageDetail): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <BranchFilesChangedPanel detail={detail} />
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BranchFilesChangedPanel", () => {
  it("renders the live file list with a GitHub source indicator + count via the slug route, never persisting", async () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 42,
    });
    const fetchSpy = mockFiles(() =>
      jsonResponse(200, {
        files: [
          { filename: "src/a.ts", additions: 7, deletions: 1 },
          { filename: "src/b.ts", additions: 3, deletions: 5 },
        ],
      })
    );

    render(renderPanel(detail));

    await waitFor(() =>
      expect(screen.getByText("src/a.ts")).toBeInTheDocument()
    );
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    // Per-file PR-sourced LOC (file a additions) + authoritative total additions.
    expect(screen.getByText("+7")).toBeInTheDocument();
    expect(screen.getByText("+10")).toBeInTheDocument();

    // Slug route (owner/repo/number) — no local repo path resolution.
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("/api/gateway/git/pr/files?");
    expect(url).toContain("owner=octo");
    expect(url).toContain("number=42");
    // No-persist: the port's filesChanged stays null; only GET reads were issued.
    expect(detail.filesChanged).toBeNull();
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method ?? "GET").toBe("GET");
    }
  });

  it("treats an empty changed-file set as a distinct empty (not the degraded state)", async () => {
    const detail = makeBranchDetail({ repoFullName: "octo/repo", prNumber: 7 });
    mockFiles(() => jsonResponse(200, { files: [] }));

    render(renderPanel(detail));

    await waitFor(() =>
      expect(screen.getByText(NO_FILES_RE)).toBeInTheDocument()
    );
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("shows the clean no-PR state (no connect CTA, no fetch) when the branch has no pull request", () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: null,
      additions: 12,
      deletions: 4,
    });
    const fetchSpy = mockFiles(() => jsonResponse(200, { files: [] }));

    render(renderPanel(detail));

    expect(screen.getByText(NO_PR_RE)).toBeInTheDocument();
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
    expect(screen.getByText("+12")).toBeInTheDocument();
    // Source indicator is always present (Local filesystem in degraded states).
    expect(screen.getByText("Local filesystem")).toBeInTheDocument();
    // No PR → identity gated → the files query never fires.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT fabricate a derived-LOC line when only one of additions/deletions is populated", () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: null,
      additions: 10,
      deletions: null,
    });
    mockFiles(() => jsonResponse(200, { files: [] }));

    render(renderPanel(detail));

    expect(screen.getByText(NO_PR_RE)).toBeInTheDocument();
    // NULL = unavailable, not 0 — never render "+10 −0".
    expect(screen.queryByText("+10")).not.toBeInTheDocument();
    expect(screen.queryByText("−0")).not.toBeInTheDocument();
  });

  it("gates with a multi-PR notice (no connect CTA, no fetch) when multiple PRs are linked", () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 42,
      multiPrWarning: true,
    });
    const fetchSpy = mockFiles(() =>
      jsonResponse(200, {
        files: [{ filename: "a.ts", additions: 1, deletions: 0 }],
      })
    );

    render(renderPanel(detail));

    expect(screen.getByText(MULTI_PR_RE)).toBeInTheDocument();
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
    expect(screen.getByText("Local filesystem")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows a connect-GitHub affordance (no thrown error) when a linked PR's files 403", async () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 9,
      additions: 3,
      deletions: 1,
    });
    mockFiles(() => jsonResponse(403, { error: "directory not allowed" }));

    render(renderPanel(detail));

    await waitFor(() =>
      expect(screen.getByText(UNAVAILABLE_RE)).toBeInTheDocument()
    );
    expect(screen.getByText(CONNECT_RE)).toBeInTheDocument();
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByText("Local filesystem")).toBeInTheDocument();
  });

  it("does NOT show the previous branch's files after navigating to a no-PR branch (no stale overlay)", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockFiles(() =>
      jsonResponse(200, {
        files: [
          { filename: "src/a.ts", additions: 1, deletions: 0 },
          { filename: "src/b.ts", additions: 1, deletions: 0 },
        ],
      })
    );

    const withPr = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 42,
    });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <BranchFilesChangedPanel detail={withPr} />
      </QueryClientProvider>
    );
    await waitFor(() =>
      expect(screen.getByText("src/a.ts")).toBeInTheDocument()
    );

    // Navigate to a branch with no PR — the previous file list must NOT persist.
    const noPr = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: null,
    });
    rerender(
      <QueryClientProvider client={client}>
        <BranchFilesChangedPanel detail={noPr} />
      </QueryClientProvider>
    );

    expect(screen.queryByText("src/a.ts")).not.toBeInTheDocument();
    expect(screen.getByText(NO_PR_RE)).toBeInTheDocument();
  });
});
