import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  type ComputeTarget,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheComputeTargetsForSigning } from "@/lib/desktop-command-signing/compute-target-signing-cache";
import {
  type BranchLocalIdentity,
  commitAndPushBranchLocalChanges,
  fetchBranchLocalChanges,
  fetchBranchLocalDiff,
  fetchBranchWorktree,
} from "../local-branch-changes";

const mockFetch = vi.hoisted(() => vi.fn());
const mockSignDesktopCommand = vi.hoisted(() => vi.fn());

vi.mock(
  "@/lib/desktop-command-signing/command-signer",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/desktop-command-signing/command-signer")
      >();
    return {
      ...actual,
      signDesktopCommand: mockSignDesktopCommand,
    };
  }
);

function makeIdentity(): BranchLocalIdentity {
  return {
    externalLinkId: "ext-1",
    headBranch: "feature",
    prNumber: 42,
    repoFullName: "acme/widget",
    repoPath: "/repo",
    routing: {
      computeTargetId: "target-1",
      mode: EngineerRoutingMode.CloudRelay,
    },
  };
}

function lastFetchHeaders(): Headers {
  const init = mockFetch.mock.calls.at(-1)?.[1] as RequestInit;
  return new Headers(init.headers);
}

function lastFetchBody(): Record<string, unknown> {
  const init = mockFetch.mock.calls.at(-1)?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function commandSigningHeaderValues(headers: Headers): Array<string | null> {
  return [
    headers.get("x-command-id"),
    headers.get("x-command-signature"),
    headers.get("x-command-signature-payload"),
    headers.get("x-command-public-key-fingerprint"),
  ];
}

function makeCachedTarget(
  overrides: Partial<ComputeTarget> = {}
): ComputeTarget {
  return {
    id: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "target-1",
    platform: "darwin",
    capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: true },
    supportedOperations: [],
    lastSeenAt: new Date("2026-05-10T12:00:00.000Z"),
    isOnline: true,
    isSharedWithOrg: false,
    serverCapabilities: { computeTargetSigning: true },
    selectedHarness: HarnessType.Claude,
    createdAt: new Date("2026-05-10T12:00:00.000Z"),
    updatedAt: new Date("2026-05-10T12:00:00.000Z"),
    ...overrides,
  };
}

describe("Branch View local CloudRelay helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    cacheComputeTargetsForSigning([makeCachedTarget()]);
    mockSignDesktopCommand.mockImplementation(({ pathWithQuery }) => ({
      commandId: `cmd:${pathWithQuery}`,
      publicKeyFingerprint: "fingerprint",
      signature: "signature",
      signaturePayload: "payload",
    }));
    mockFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue("{}"),
    });
  });

  it("signs local list commands with the Desktop gateway path", async () => {
    await fetchBranchLocalChanges(makeIdentity());

    expect(mockSignDesktopCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        pathWithQuery:
          "/api/gateway/git/local-changes?repoPath=%2Frepo&repoFullName=acme%2Fwidget&headBranch=feature&prNumber=42",
      }),
      expect.objectContaining({ id: "target-1" })
    );
    expect(lastFetchHeaders().get("x-command-id")).toContain(
      "/api/gateway/git/local-changes"
    );
  });

  it("signs local diff command bodies before sending them through the Branch View local endpoint", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          isBinary: false,
          isDeleted: false,
          isNew: false,
          newContent: "new",
          oldContent: "old",
          path: "src/app.ts",
        })
      ),
    });

    await fetchBranchLocalDiff({
      ...makeIdentity(),
      path: "src/app.ts",
      previousPath: null,
    });

    expect(mockSignDesktopCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ path: "src/app.ts" }),
        method: "POST",
        pathWithQuery: "/api/gateway/git/local-changes/diff",
      }),
      expect.objectContaining({ id: "target-1" })
    );
    expect(lastFetchHeaders().get("x-command-signature")).toBe("signature");
  });

  it("omits signing headers when the refreshed cache marks the target ineligible", async () => {
    cacheComputeTargetsForSigning([
      makeCachedTarget({ serverCapabilities: {} }),
    ]);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          isBinary: false,
          isDeleted: false,
          isNew: false,
          newContent: "new",
          oldContent: "old",
          path: "src/app.ts",
        })
      ),
    });

    await fetchBranchLocalDiff({
      ...makeIdentity(),
      path: "src/app.ts",
      previousPath: null,
    });

    expect(mockSignDesktopCommand).not.toHaveBeenCalled();
    expect(lastFetchHeaders().get("x-compute-target")).toBe("target-1");
    expect(commandSigningHeaderValues(lastFetchHeaders())).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("signs commit-push command bodies and keeps approval headers", async () => {
    await commitAndPushBranchLocalChanges({
      ...makeIdentity(),
      message: "Update widget",
    });

    expect(mockSignDesktopCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ message: "Update widget" }),
        method: "POST",
        pathWithQuery: "/api/gateway/git/local-changes/commit-push",
      }),
      expect.objectContaining({ id: "target-1" })
    );
    expect(lastFetchHeaders().get("x-command-public-key-fingerprint")).toBe(
      "fingerprint"
    );
    expect(lastFetchHeaders().get("x-desktop-force-approval")).toBe("1");
    expect(lastFetchHeaders().get("x-desktop-approval-reason")).toBe(
      "Commit and push local Branch View changes for acme/widget#42"
    );
    expect(lastFetchBody()).toEqual(
      expect.objectContaining({
        headBranch: "feature",
        message: "Update widget",
        prNumber: "42",
        repoFullName: "acme/widget",
        repoPath: "/repo",
      })
    );
  });

  it("omits signing headers when the refreshed cache removes the target", async () => {
    cacheComputeTargetsForSigning([]);

    await commitAndPushBranchLocalChanges({
      ...makeIdentity(),
      message: "Update widget",
    });

    expect(mockSignDesktopCommand).not.toHaveBeenCalled();
    expect(lastFetchHeaders().get("x-compute-target")).toBe("target-1");
    expect(commandSigningHeaderValues(lastFetchHeaders())).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(lastFetchHeaders().get("x-desktop-force-approval")).toBe("1");
    expect(lastFetchHeaders().get("x-desktop-approval-reason")).toBe(
      "Commit and push local Branch View changes for acme/widget#42"
    );
  });

  it("treats missing Desktop worktrees as a no-worktree state", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue("{}"),
    });

    await expect(
      fetchBranchWorktree({
        headBranch: "feature",
        prNumber: 42,
        repoFullName: "acme/widget",
      })
    ).resolves.toEqual({ path: null, repoPath: null });
  });

  it("maps unsupported Desktop local-change responses to the unsupported state", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 501,
      text: vi.fn().mockResolvedValue("{}"),
    });

    await expect(fetchBranchLocalChanges(makeIdentity())).rejects.toThrow(
      "unsupported_desktop_version"
    );
  });

  it("treats null local-change list bodies as an empty file list", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue("null"),
    });

    await expect(fetchBranchLocalChanges(makeIdentity())).resolves.toEqual([]);
  });

  it("rejects invalid local diff response bodies before returning typed data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ path: "src/app.ts" })),
    });

    await expect(
      fetchBranchLocalDiff({
        ...makeIdentity(),
        path: "src/app.ts",
        previousPath: null,
      })
    ).rejects.toThrow("invalid_local_diff_response");
  });

  it("rejects null commit-push response bodies before returning success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue("null"),
    });

    await expect(
      commitAndPushBranchLocalChanges({
        ...makeIdentity(),
        message: "Update widget",
      })
    ).rejects.toThrow("invalid_local_commit_response");
  });
});
