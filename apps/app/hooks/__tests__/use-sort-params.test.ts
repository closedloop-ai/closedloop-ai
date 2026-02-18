import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useSortParams } from "../use-sort-params";

// Use vi.fn() so mockReturnValue works per-test (not closed-over variable).
// Wrap in arrow function to avoid TDZ error when vi.mock factory is hoisted.
const mockReplace = vi.fn();
const mockUseSearchParams = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockUseSearchParams(),
  usePathname: () => "/test-path",
}));

const VALID_COLUMNS = ["title", "updatedAt", "type"] as const;
type TestColumn = (typeof VALID_COLUMNS)[number];

describe("useSortParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSearchParams.mockReturnValue(new URLSearchParams());
  });

  describe("reading sort state from URL", () => {
    test("returns default column and direction when no URL params", () => {
      mockUseSearchParams.mockReturnValue(new URLSearchParams());

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          validColumns: VALID_COLUMNS,
        })
      );

      expect(result.current.sortBy).toBe("updatedAt");
      expect(result.current.sortDir).toBe("desc");
    });

    test("restores sortBy from URL params (deep-link restore)", () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams("sortBy=title&sortDir=asc")
      );

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          validColumns: VALID_COLUMNS,
        })
      );

      expect(result.current.sortBy).toBe("title");
      expect(result.current.sortDir).toBe("asc");
    });

    test("restores sortDir=desc from URL params", () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams("sortBy=type&sortDir=desc")
      );

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "asc",
          validColumns: VALID_COLUMNS,
        })
      );

      expect(result.current.sortBy).toBe("type");
      expect(result.current.sortDir).toBe("desc");
    });

    test("uses defaultDirection when sortDir param is absent", () => {
      mockUseSearchParams.mockReturnValue(new URLSearchParams("sortBy=title"));

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "asc",
          validColumns: VALID_COLUMNS,
        })
      );

      expect(result.current.sortDir).toBe("asc");
    });

    test("sanitizes invalid sortDir value, falls back to defaultDirection", () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams("sortBy=title&sortDir=invalid")
      );

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          validColumns: VALID_COLUMNS,
        })
      );

      expect(result.current.sortDir).toBe("desc");
    });

    test("sanitizes invalid sortBy value, falls back to defaultColumn", () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams("sortBy=notAColumn&sortDir=asc")
      );

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          validColumns: VALID_COLUMNS,
        })
      );

      expect(result.current.sortBy).toBe("updatedAt");
    });

    test("returns null sortBy when defaultColumn is null and no URL params", () => {
      mockUseSearchParams.mockReturnValue(new URLSearchParams());

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: null,
          defaultDirection: "desc",
          validColumns: VALID_COLUMNS,
        })
      );

      expect(result.current.sortBy).toBeNull();
    });

    test("uses 'desc' as fallback direction when defaultDirection not specified", () => {
      mockUseSearchParams.mockReturnValue(new URLSearchParams());

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "title",
          validColumns: VALID_COLUMNS,
        })
      );

      expect(result.current.sortDir).toBe("desc");
    });
  });

  describe("setSort updates URL", () => {
    test("calls router.replace with sortBy and sortDir params", () => {
      mockUseSearchParams.mockReturnValue(new URLSearchParams());

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          validColumns: VALID_COLUMNS,
        })
      );

      act(() => {
        result.current.setSort("title", "asc");
      });

      expect(mockReplace).toHaveBeenCalledWith(
        "/test-path?sortBy=title&sortDir=asc",
        { scroll: false }
      );
    });

    test("preserves existing unrelated URL params when setting sort", () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams("filter=active&page=2")
      );

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          validColumns: VALID_COLUMNS,
        })
      );

      act(() => {
        result.current.setSort("title", "asc");
      });

      const calledUrl = mockReplace.mock.calls[0][0] as string;
      const params = new URLSearchParams(calledUrl.split("?")[1]);
      expect(params.get("filter")).toBe("active");
      expect(params.get("page")).toBe("2");
      expect(params.get("sortBy")).toBe("title");
      expect(params.get("sortDir")).toBe("asc");
    });

    test("updates sortDir when changing column direction", () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams("sortBy=title&sortDir=asc")
      );

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          validColumns: VALID_COLUMNS,
        })
      );

      act(() => {
        result.current.setSort("title", "desc");
      });

      expect(mockReplace).toHaveBeenCalledWith(
        "/test-path?sortBy=title&sortDir=desc",
        { scroll: false }
      );
    });
  });

  describe("clearSort removes params from URL", () => {
    test("removes sortBy and sortDir params from URL", () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams("sortBy=title&sortDir=asc&filter=active")
      );

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          validColumns: VALID_COLUMNS,
        })
      );

      act(() => {
        result.current.clearSort();
      });

      expect(mockReplace).toHaveBeenCalledWith("/test-path?filter=active", {
        scroll: false,
      });
    });

    test("navigates to pathname without trailing ? when no params remain after clearSort", () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams("sortBy=title&sortDir=asc")
      );

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          validColumns: VALID_COLUMNS,
        })
      );

      act(() => {
        result.current.clearSort();
      });

      expect(mockReplace).toHaveBeenCalledWith("/test-path", { scroll: false });
    });
  });

  describe("paramPrefix support", () => {
    test("reads sort params with prefix", () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams("workstreams_sortBy=title&workstreams_sortDir=asc")
      );

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          paramPrefix: "workstreams_",
          validColumns: VALID_COLUMNS,
        })
      );

      expect(result.current.sortBy).toBe("title");
      expect(result.current.sortDir).toBe("asc");
    });

    test("writes sort params with prefix", () => {
      mockUseSearchParams.mockReturnValue(new URLSearchParams());

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          paramPrefix: "workstreams_",
          validColumns: VALID_COLUMNS,
        })
      );

      act(() => {
        result.current.setSort("type", "asc");
      });

      expect(mockReplace).toHaveBeenCalledWith(
        "/test-path?workstreams_sortBy=type&workstreams_sortDir=asc",
        { scroll: false }
      );
    });

    test("does not read unprefixed params when prefix is set", () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams("sortBy=title&sortDir=asc")
      );

      const { result } = renderHook(() =>
        useSortParams<TestColumn>({
          defaultColumn: "updatedAt",
          defaultDirection: "desc",
          paramPrefix: "workstreams_",
          validColumns: VALID_COLUMNS,
        })
      );

      // Should fall back to default since the unprefixed params don't match the prefix
      expect(result.current.sortBy).toBe("updatedAt");
    });
  });
});
