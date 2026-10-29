import { Priority } from "@repo/api/src/types/common";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectInlineIssueCreation } from "../use-project-inline-issue-creation";

const create = vi.hoisted(() => vi.fn());
vi.mock("../../../documents/hooks/use-documents", () => ({
  useCreateDocument: () => ({ mutateAsync: create }),
}));
const input = {
  type: DocumentType.Feature,
  title: "Follow up",
  content: "",
  projectId: "project",
  status: IssueStatus.Todo,
  assigneeId: "owner",
  priority: Priority.High,
};
beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({ id: "created" });
});
describe("project inline issue creation", () => {
  it("places against the authoritative post-create read and inherits group defaults", async () => {
    const refresh = vi.fn().mockResolvedValue({
      nodes: [],
      externalParents: [],
      projectVersion: "post-create",
    });
    const place = vi.fn().mockResolvedValue(undefined);
    const advance = vi.fn();
    const { result } = renderHook(() => useProjectInlineIssueCreation());
    await act(() =>
      result.current({
        input,
        groupKey: "owner",
        afterId: "previous",
        refresh,
        place,
        advance,
      })
    );
    expect(create).toHaveBeenCalledWith(input);
    expect(refresh).toHaveBeenCalledOnce();
    expect(place).toHaveBeenCalledWith("created", "previous", "post-create");
    expect(advance).toHaveBeenCalledWith("created");
  });
  it("retains the created identity and draft after placement rejects, without creating a duplicate on retry", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ projectVersion: "post-create" })
      .mockResolvedValueOnce({ projectVersion: "retry-read" });
    const place = vi
      .fn()
      .mockRejectedValueOnce(new Error("Conflict"))
      .mockResolvedValue(undefined);
    const advance = vi.fn();
    const { result } = renderHook(() => useProjectInlineIssueCreation());
    const args = { input, afterId: "previous", refresh, place, advance };
    await expect(act(() => result.current(args))).rejects.toThrow("Conflict");
    expect(advance).not.toHaveBeenCalled();
    await act(() => result.current(args));
    expect(create).toHaveBeenCalledOnce();
    expect(place).toHaveBeenNthCalledWith(
      2,
      "created",
      "previous",
      "retry-read"
    );
    expect(advance).toHaveBeenCalledOnce();
  });
  it("does not attempt placement without a fresh revision and retains the existing created record", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ nodes: [], externalParents: [] })
      .mockResolvedValueOnce({ projectVersion: "available" });
    const place = vi.fn();
    const advance = vi.fn();
    const { result } = renderHook(() => useProjectInlineIssueCreation());
    const args = { input, afterId: "previous", refresh, place, advance };
    await expect(act(() => result.current(args))).rejects.toThrow(
      "version unavailable"
    );
    expect(place).not.toHaveBeenCalled();
    await act(() => result.current(args));
    expect(create).toHaveBeenCalledOnce();
  });
});
