import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/compute-targets/[id]/commands/[commandId]/events/route";
import { computeTargetsService } from "@/app/compute-targets/service";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import { authorizeBranchViewLocalEventRead } from "@/lib/branch-view-local-authorization";
import { desktopCommandStore } from "@/lib/desktop-command-store";

vi.mock("@/lib/auth/resolve-any-auth-context", () => ({
  resolveAnyAuthContext: vi.fn(),
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findAccessibleById: vi.fn(),
  },
}));

vi.mock("@/lib/branch-view-local-authorization", () => ({
  authorizeBranchViewLocalEventRead: vi.fn(),
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    getCommand: vi.fn(),
    getCommandEvents: vi.fn(),
    subscribeCommandEvents: vi.fn(),
  },
}));

const routeContext = {
  params: Promise.resolve({ id: "target-1", commandId: "cmd-local" }),
};

function request(url: string): Request {
  return new Request(url, {
    headers: { Authorization: "Bearer token" },
  });
}

function allowLocalEventRead(): void {
  vi.mocked(authorizeBranchViewLocalEventRead).mockResolvedValue({
    ok: true,
    metadataHeaders: {},
  });
}

function denyLocalEventRead(): void {
  vi.mocked(authorizeBranchViewLocalEventRead).mockResolvedValue({
    ok: false,
    status: 403,
    code: "branch_view_not_author",
    error: "branch_view_not_author",
  });
}

async function readStreamText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("expected response body reader");
  }
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("Branch View local command event authorization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(resolveAnyAuthContext).mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
    });
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue({
      id: "target-1",
    } as never);
    vi.mocked(desktopCommandStore.getCommand).mockResolvedValue({
      commandId: "cmd-local",
    } as never);
    vi.mocked(desktopCommandStore.getCommandEvents).mockResolvedValue([
      {
        commandId: "cmd-local",
        sequence: 1,
        eventType: "result",
        data: { local: "content" },
        createdAt: new Date().toISOString(),
      },
    ] as never);
    vi.mocked(desktopCommandStore.subscribeCommandEvents).mockResolvedValue(
      () => undefined
    );
    allowLocalEventRead();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reauthorizes before JSON replay and denies without reading persisted payloads", async () => {
    vi.mocked(authorizeBranchViewLocalEventRead)
      .mockResolvedValueOnce({ ok: true, metadataHeaders: {} })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        code: "branch_view_not_author",
        error: "branch_view_not_author",
      });

    const response = await GET(
      request(
        "https://api.test/compute-targets/target-1/commands/cmd-local/events"
      ),
      routeContext
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "branch_view_not_author",
      code: "branch_view_not_author",
    });
    expect(desktopCommandStore.getCommandEvents).not.toHaveBeenCalled();
  });

  it("reauthorizes before SSE replay and closes without subscribing when proof is invalid", async () => {
    vi.mocked(authorizeBranchViewLocalEventRead)
      .mockResolvedValueOnce({ ok: true, metadataHeaders: {} })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        code: "branch_view_not_author",
        error: "branch_view_not_author",
      });

    const response = await GET(
      request(
        "https://api.test/compute-targets/target-1/commands/cmd-local/events?stream=true"
      ),
      routeContext
    );
    const text = await readStreamText(response);

    expect(response.status).toBe(200);
    expect(text).toContain("branch_view_not_author");
    expect(desktopCommandStore.subscribeCommandEvents).not.toHaveBeenCalled();
  });

  it("reauthorizes every SSE poll batch before reading persisted events", async () => {
    allowLocalEventRead();
    const response = await GET(
      request(
        "https://api.test/compute-targets/target-1/commands/cmd-local/events?stream=true"
      ),
      routeContext
    );
    denyLocalEventRead();

    const outputPromise = readStreamText(response);
    await vi.advanceTimersByTimeAsync(2000);
    const text = await outputPromise;

    expect(text).toContain("branch_view_not_author");
    expect(authorizeBranchViewLocalEventRead).toHaveBeenCalledTimes(3);
    expect(desktopCommandStore.getCommandEvents).not.toHaveBeenCalled();
  });
});
