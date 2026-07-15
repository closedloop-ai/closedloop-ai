import {
  type BranchPageDetail,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import { BranchFilesChangedPanel } from "../branch-files-changed-panel";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("react-diff-viewer-continued", () => ({
  default: ({ newValue, oldValue }: { newValue: string; oldValue: string }) => (
    <div data-testid="shared-branch-file-diff-viewer">
      <pre>{oldValue}</pre>
      <pre>{newValue}</pre>
    </div>
  ),
  DiffMethod: { WORDS: "WORDS" },
}));

const NO_FILES_RE = /changed no files/i;
const NO_PR_RE = /changed files appear here once a pull request is opened/i;
const MULTI_PR_RE = /multiple pull requests are linked/i;
const UNAVAILABLE_RE = /changed files for pull request #9 are not available/i;
const CONNECT_RE = /light up this metric/i;

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text),
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
      <BranchFilesChangedPanel branchId={detail.id} detail={detail} />
    </QueryClientProvider>
  );
}

const OCTO_REPO_BRANCH_ID = encodeBranchId({
  repoFullName: "octo/repo",
  branchName: "feature/x",
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BranchFilesChangedPanel", () => {
  it("renders the live file list with a GitHub source indicator + count via the slug route, never persisting", async () => {
    const detail = makeBranchDetail({
      id: OCTO_REPO_BRANCH_ID,
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

  it("lists files from the linked PR URL when the branch repo identity is missing", async () => {
    const detail = makeBranchDetail({
      repoFullName: null,
      prUrl: "https://github.com/octo/repo/pull/42",
      prNumber: 42,
    });
    const fetchSpy = mockFiles(() =>
      jsonResponse(200, {
        files: [{ filename: "src/from-url.ts", additions: 4, deletions: 2 }],
      })
    );

    render(renderPanel(detail));

    await waitFor(() =>
      expect(screen.getByText("src/from-url.ts")).toBeInTheDocument()
    );
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("owner=octo");
    expect(url).toContain("repo=repo");
    expect(url).toContain("number=42");
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

  it("shows a local unavailable state when a linked PR's files 403", async () => {
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
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
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

  it("opens a selected file's desktop gateway diff inline", async () => {
    const detail = makeBranchDetail({
      id: OCTO_REPO_BRANCH_ID,
      repoFullName: "octo/repo",
      prNumber: 42,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const href = String(url);
      if (href.includes("/api/gateway/git/pr/files?")) {
        return Promise.resolve(
          jsonResponse(200, {
            files: [{ filename: "src/a.ts", additions: 7, deletions: 1 }],
          })
        );
      }
      if (href.includes("/api/gateway/git/pr/file-diff?")) {
        return Promise.resolve(
          jsonResponse(200, {
            path: "src/a.ts",
            oldContent: "const before = 1;",
            newContent: "const after = 2;",
            isNew: false,
            isDeleted: false,
            isBinary: false,
          })
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${href}`));
    });

    render(renderPanel(detail));

    await userEvent.click(
      await screen.findByLabelText("Open diff for src/a.ts")
    );

    expect(
      await screen.findByTestId("shared-branch-file-diff-viewer")
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Open diff for src/a.ts")
    ).not.toBeInTheDocument();
    expect(await screen.findByText("const before = 1;")).toBeInTheDocument();
    expect(screen.getByText("const after = 2;")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Back to files changed"));
    expect(
      screen.queryByTestId("branch-file-diff-preview")
    ).not.toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    const diffUrl = fetchSpy.mock.calls
      .map((call) => String(call[0]))
      .find((href) => href.includes("/api/gateway/git/pr/file-diff?"));
    expect(diffUrl).toBeDefined();
    expect(diffUrl).toContain("path=src%2Fa.ts");
    expect(diffUrl).toContain("owner=octo");
    expect(diffUrl).toContain("repo=repo");
    expect(diffUrl).toContain("number=42");
    expect(diffUrl).toContain("branchId=octo%252Frepo%3A%3Afeature%252Fx");
    expect(diffUrl).not.toContain("previousPath=");
  });

  it("passes rename metadata through to the desktop gateway diff query", async () => {
    const detail = makeBranchDetail({
      id: OCTO_REPO_BRANCH_ID,
      repoFullName: "octo/repo",
      prNumber: 42,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const href = String(url);
      if (href.includes("/api/gateway/git/pr/files?")) {
        return Promise.resolve(
          jsonResponse(200, {
            files: [
              {
                filename: "src/new.ts",
                previous_filename: "src/old.ts",
                status: "renamed",
                additions: 2,
                deletions: 1,
              },
            ],
          })
        );
      }
      if (href.includes("/api/gateway/git/pr/file-diff?")) {
        return Promise.resolve(
          jsonResponse(200, {
            path: "src/new.ts",
            oldContent: "old",
            newContent: "new",
            isNew: false,
            isDeleted: false,
            isBinary: false,
          })
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${href}`));
    });

    render(renderPanel(detail));

    await userEvent.click(
      await screen.findByLabelText("Open diff for src/new.ts")
    );

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((call) =>
          String(call[0]).includes("file-diff")
        )
      ).toBe(true)
    );
    const diffUrl = fetchSpy.mock.calls
      .map((call) => String(call[0]))
      .find((href) => href.includes("/api/gateway/git/pr/file-diff?"));
    expect(diffUrl).toContain("path=src%2Fnew.ts");
    expect(diffUrl).toContain("previousPath=src%2Fold.ts");
  });

  it("keeps a selected diff failure local to the preview", async () => {
    const detail = makeBranchDetail({
      id: OCTO_REPO_BRANCH_ID,
      repoFullName: "octo/repo",
      prNumber: 42,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const href = String(url);
      if (href.includes("/api/gateway/git/pr/files?")) {
        return Promise.resolve(
          jsonResponse(200, {
            files: [{ filename: "src/a.ts", additions: 1, deletions: 1 }],
          })
        );
      }
      if (href.includes("/api/gateway/git/pr/file-diff?")) {
        return Promise.resolve(
          jsonResponse(400, {
            error: "previousPath does not match pull request",
          })
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${href}`));
    });

    render(renderPanel(detail));

    await userEvent.click(
      await screen.findByLabelText("Open diff for src/a.ts")
    );

    expect(
      await screen.findByText("Failed to load this file diff.")
    ).toBeInTheDocument();
    expect(screen.getAllByText("src/a.ts").length).toBeGreaterThan(0);
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("clears a selected diff when the PR identity changes", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const href = String(url);
      if (
        href.includes("/api/gateway/git/pr/files?") &&
        href.includes("number=42")
      ) {
        return Promise.resolve(
          jsonResponse(200, {
            files: [{ filename: "src/a.ts", additions: 1, deletions: 0 }],
          })
        );
      }
      if (
        href.includes("/api/gateway/git/pr/files?") &&
        href.includes("number=43")
      ) {
        return Promise.resolve(
          jsonResponse(200, {
            files: [{ filename: "src/a.ts", additions: 2, deletions: 0 }],
          })
        );
      }
      if (href.includes("/api/gateway/git/pr/file-diff?")) {
        return Promise.resolve(
          jsonResponse(200, {
            path: "src/a.ts",
            oldContent: "old",
            newContent: "new",
            isNew: false,
            isDeleted: false,
            isBinary: false,
          })
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${href}`));
    });

    const firstPr = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 42,
    });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <BranchFilesChangedPanel detail={firstPr} />
      </QueryClientProvider>
    );
    await userEvent.click(
      await screen.findByLabelText("Open diff for src/a.ts")
    );
    expect(
      await screen.findByTestId("branch-file-diff-preview")
    ).toBeInTheDocument();

    const secondPr = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 43,
    });
    rerender(
      <QueryClientProvider client={client}>
        <BranchFilesChangedPanel detail={secondPr} />
      </QueryClientProvider>
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("branch-file-diff-preview")
      ).not.toBeInTheDocument()
    );

    rerender(
      <QueryClientProvider client={client}>
        <BranchFilesChangedPanel detail={firstPr} />
      </QueryClientProvider>
    );

    await waitFor(() =>
      expect(screen.getByText("src/a.ts")).toBeInTheDocument()
    );
    expect(
      screen.queryByTestId("branch-file-diff-preview")
    ).not.toBeInTheDocument();
  });
});
