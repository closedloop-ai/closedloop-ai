import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import { ApiError } from "@repo/app/shared/api/api-error";
import { describe, expect, it, vi } from "vitest";
import {
  SHARED_BRANCHES_NOT_FOUND_CODE,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
} from "../../../shared/shared-branches-contract";
import type { DesktopApi } from "../../types/desktop-api";
import { createLocalBranchesDataSource } from "../local-branches-data-source";

const LIST: BranchListResponse = { items: [], total: 3, viewerScope: "self" };
const USAGE = { totalBranches: 3 } as unknown as BranchUsageSummary;
const ANALYTICS = { viewerScope: "self" } as unknown as BranchAnalytics;
const DETAIL = { id: "repo%2Fowner::main" } as unknown as BranchPageDetail;

type BranchesApi = DesktopApi["branchesApi"];

function fakeDesktopApi(
  overrides: Partial<BranchesApi> = {},
  onDbChanged?: DesktopApi["onDbChanged"]
): Parameters<typeof createLocalBranchesDataSource>[0] {
  return {
    branchesApi: {
      list: vi.fn(async () => LIST),
      detail: vi.fn(async () => DETAIL),
      usage: vi.fn(async () => USAGE),
      analytics: vi.fn(async () => ANALYTICS),
      ...overrides,
    },
    onDbChanged,
  };
}

describe("createLocalBranchesDataSource", () => {
  it("identifies as the local scope", () => {
    expect(createLocalBranchesDataSource(fakeDesktopApi()).scope).toBe("local");
  });

  it("forwards filters to the IPC reads and returns their payloads", async () => {
    const api = fakeDesktopApi();
    const source = createLocalBranchesDataSource(api);

    await expect(source.list({ repo: "x/y", owner: "alice" })).resolves.toBe(
      LIST
    );
    await expect(source.usage({ status: "merged" })).resolves.toBe(USAGE);
    await expect(source.analytics({})).resolves.toBe(ANALYTICS);

    expect(api.branchesApi.list).toHaveBeenCalledWith({
      repo: "x/y",
      owner: "alice",
    });
    expect(api.branchesApi.usage).toHaveBeenCalledWith({ status: "merged" });
    expect(api.branchesApi.analytics).toHaveBeenCalledWith({});
  });

  it("returns a present detail unchanged", async () => {
    const source = createLocalBranchesDataSource(fakeDesktopApi());
    await expect(source.detail("repo%2Fowner::main")).resolves.toBe(DETAIL);
  });

  it("rejects a missing detail as a 404 ApiError instead of resolving null", async () => {
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({ detail: vi.fn(async () => null) })
    );

    const error = await source.detail("missing").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe(SHARED_BRANCHES_NOT_FOUND_CODE);
  });

  it("maps a source failure to a sanitized 500 ApiError without leaking the raw error", async () => {
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({
        list: vi.fn(() =>
          Promise.reject(new Error("sql error reading /Users/secret/cwd"))
        ),
      })
    );

    const error = await source.list({}).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe(SHARED_BRANCHES_SOURCE_ERROR_CODE);
    expect(error.message).toBe("Branches source failed.");
    expect(error.message).not.toContain("secret");
  });

  it("maps a detail source failure to a 500 (not a 404)", async () => {
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({ detail: vi.fn(() => Promise.reject(new Error("boom"))) })
    );

    const error = await source.detail("x").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe(SHARED_BRANCHES_SOURCE_ERROR_CODE);
  });

  it("wires subscribe to onDbChanged as a broad change (branchId undefined)", () => {
    const unsubscribe = vi.fn();
    const onDbChanged = vi.fn(
      (_cb: (payload: { sessionId?: string }) => void) => unsubscribe
    );
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({}, onDbChanged)
    );

    const onChange = vi.fn();
    const stop = source.subscribe?.(onChange);
    expect(onDbChanged).toHaveBeenCalledTimes(1);

    // Any session DB change maps to a BROAD branch change ({} — no branchId).
    const forward = onDbChanged.mock.calls[0]?.[0];
    forward?.({ sessionId: "session-9" });
    expect(onChange).toHaveBeenCalledWith({});

    stop?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("omits subscribe when the preload exposes no onDbChanged", () => {
    const source = createLocalBranchesDataSource(fakeDesktopApi());
    expect(source.subscribe).toBeUndefined();
  });
});
