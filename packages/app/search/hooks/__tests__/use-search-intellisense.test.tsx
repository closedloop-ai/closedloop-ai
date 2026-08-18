import { SearchFilterKey } from "@repo/api/src/types/search-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mockMembers, mockProjects } = vi.hoisted(() => ({
  mockMembers: vi.fn(),
  mockProjects: vi.fn(),
}));

vi.mock("../use-search-suggestions", async () => {
  const actual = await vi.importActual<
    typeof import("../use-search-suggestions")
  >("../use-search-suggestions");
  return {
    ...actual,
    useMemberSuggestions: (enabled: boolean) => mockMembers(enabled),
    useProjectSuggestions: (enabled: boolean) => mockProjects(enabled),
  };
});

import { IntellisenseMode } from "../../lib/search-intellisense";
import { useSearchIntellisense } from "../use-search-intellisense";

const EMPTY = { options: [], isLoading: false, isError: false };

function setup(raw: string, caret: number) {
  return renderHook(() => useSearchIntellisense(raw, caret));
}

describe("useSearchIntellisense", () => {
  it("shows filter-key rows for a partial word and stays closed on empty", () => {
    mockMembers.mockReturnValue(EMPTY);
    mockProjects.mockReturnValue(EMPTY);

    const { result } = setup("stat", 4);
    expect(result.current.isOpen).toBe(true);
    expect(result.current.mode).toBe(IntellisenseMode.FilterKeys);
    expect(result.current.rows[0]).toEqual({
      kind: "key",
      suggestion: expect.objectContaining({
        meta: expect.objectContaining({ key: SearchFilterKey.Status }),
      }),
    });
    // The member/project sources are NOT fetched for a key surface.
    expect(mockMembers).toHaveBeenCalledWith(false);
    expect(mockProjects).toHaveBeenCalledWith(false);
  });

  it("gates the member fetch on the `@` surface and maps rows", () => {
    mockMembers.mockReturnValue({
      options: [{ value: "alice-gh", label: "Alice", detail: "alice-gh" }],
      isLoading: false,
      isError: false,
    });
    mockProjects.mockReturnValue(EMPTY);

    const { result } = setup("@al", 3);
    expect(mockMembers).toHaveBeenCalledWith(true);
    expect(result.current.mode).toBe(IntellisenseMode.Members);
    expect(result.current.rows).toEqual([
      {
        kind: "member",
        option: { value: "alice-gh", label: "Alice", detail: "alice-gh" },
      },
    ]);
  });

  it("surfaces the dynamic loading state honestly while members resolve", () => {
    mockMembers.mockReturnValue({
      options: [],
      isLoading: true,
      isError: false,
    });
    mockProjects.mockReturnValue(EMPTY);

    const { result } = setup("@", 1);
    expect(result.current.isOpen).toBe(true);
    expect(result.current.isLoading).toBe(true);
  });

  it("gates the project fetch on the `:project=` surface", () => {
    mockMembers.mockReturnValue(EMPTY);
    mockProjects.mockReturnValue({
      options: [{ value: "acme", label: "Acme" }],
      isLoading: false,
      isError: false,
    });

    const { result } = setup("project=ac", 10);
    expect(mockProjects).toHaveBeenCalledWith(true);
    expect(mockMembers).toHaveBeenCalledWith(false);
    expect(result.current.mode).toBe(IntellisenseMode.DynamicValues);
    // A project value is a `dynamic-value` row, NOT a `member` row, so it commits
    // as `project:slug` rather than an `@mention`.
    expect(result.current.rows[0]).toEqual({
      kind: "dynamic-value",
      option: { value: "acme", label: "Acme" },
    });
  });

  it("commitRow rewrites a project value as `project:slug`, not an @mention", () => {
    mockMembers.mockReturnValue(EMPTY);
    mockProjects.mockReturnValue({
      options: [{ value: "acme", label: "Acme", detail: "acme" }],
      isLoading: false,
      isError: false,
    });

    const { result } = setup("project=ac", 10);
    const commit = result.current.commitRow(0);
    expect(commit?.text).toBe("project:acme ");
  });

  it("commitRow rewrites a static value token to `key:value`", () => {
    mockMembers.mockReturnValue(EMPTY);
    mockProjects.mockReturnValue(EMPTY);

    const { result } = setup("priority:med", 12);
    // MEDIUM is the only substring match for "med".
    const commit = result.current.commitRow(0);
    expect(commit?.text).toBe("priority:MEDIUM ");
  });

  it("commitRow returns null for an out-of-range index", () => {
    mockMembers.mockReturnValue(EMPTY);
    mockProjects.mockReturnValue(EMPTY);
    const { result } = setup("stat", 4);
    expect(result.current.commitRow(99)).toBeNull();
  });

  it("stays closed (falls back to FTS) for free text", () => {
    mockMembers.mockReturnValue(EMPTY);
    mockProjects.mockReturnValue(EMPTY);
    const { result } = setup("http://x.com", 12);
    expect(result.current.isOpen).toBe(false);
    expect(result.current.mode).toBe(IntellisenseMode.FreeText);
  });
});
